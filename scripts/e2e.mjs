// End-to-end browser checks for the portfolio.
// Usage: node scripts/e2e.mjs
// Requires the local server on http://127.0.0.1:4173 and Microsoft Edge.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 9224;
const profile = path.join(os.tmpdir(), 'edge-e2e-' + Date.now());
const base = 'http://127.0.0.1:4173';

const edgePaths = [
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const edge = edgePaths.find((candidate) => fs.existsSync(candidate));
if (!edge) throw new Error('Microsoft Edge not found');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const proc = spawn(
	edge,
	[
		'--headless',
		'--disable-gpu',
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'about:blank',
	],
	{ stdio: 'ignore' }
);

let ws;
let nextID = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextID;
		pending.set(id, (message) => {
			if (message.error) reject(new Error(method + ': ' + JSON.stringify(message.error)));
			else resolve(message.result);
		});
		ws.send(JSON.stringify({ id, method, params }));
	});
}

async function evaluate(expression, awaitPromise = false) {
	const result = await send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise,
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.text + ': ' + expression);
	}
	return result.result.value;
}

async function waitFor(expression, label, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await evaluate(`Boolean(${expression})`)) return;
		await sleep(120);
	}
	throw new Error('Timed out waiting for ' + label);
}

function assert(condition, label) {
	if (!condition) throw new Error('FAIL: ' + label);
	console.log('PASS: ' + label);
}

async function readOutput() {
	const raw = await evaluate(`(() => {
		const meta = document.querySelector('#console-output .console-meta');
		const error = document.querySelector('#console-output .console-error');
		const rows = [...document.querySelectorAll('#console-output tbody tr')];
		return JSON.stringify({
			meta: meta ? meta.textContent : null,
			error: error ? error.textContent : null,
			rows: rows.map((row) => [...row.children].map((cell) => cell.textContent)),
			headers: [...document.querySelectorAll('#console-output th')].map((th) => th.textContent),
		});
	})()`);
	return JSON.parse(raw);
}

async function clickExample(id, expectedText) {
	await evaluate(`document.querySelector('[data-example="${id}"]').click()`);
	await waitFor(
		`document.querySelector('#console-output').textContent.includes(${JSON.stringify(expectedText)})`,
		`example ${id}`
	);
	const output = await readOutput();
	assert(output.rows.length > 0, `example ${id} returns rows`);
	assert(!output.error, `example ${id} has no error`);
	return output;
}

async function about() {
	const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
	return version;
}

async function main() {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) break;
		} catch {
			/* not ready */
		}
		await sleep(200);
	}
	await about();

	const target = await (
		await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
	).json();
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	ws.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
			return;
		}
		if (message.method === 'Runtime.exceptionThrown') {
			pageErrors.push(message.params.exceptionDetails.text || 'runtime exception');
		}
		if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
			pageErrors.push(message.params.entry.text);
		}
	});

	await send('Page.enable');
	await send('Runtime.enable');
	await send('Log.enable');
	await send('Emulation.setDeviceMetricsOverride', {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await send('Page.navigate', { url: base + '/' });
	await waitFor(`document.readyState === 'complete'`, 'page load');
	// Exercise the normal path: the console boots when the section approaches view.
	await evaluate(`document.documentElement.style.scrollBehavior = 'auto';
		document.getElementById('joydb').scrollIntoView();`);
	await waitFor('window.JoyDB && window.JoyDB.ready', 'JoyDB boot in browser', 30000);

	const status = await evaluate(`document.getElementById('console-status-text').textContent`);
	assert(/^READY/.test(status), 'console reports READY (' + status + ')');
	assert(!/0MS/.test(status), 'boot time is not displayed as zero');

	const career = await readOutput();
	assert(career.rows.length === 3, 'default career query returns 3 rows');
	assert(career.rows[0][0] === 'Microsoft', 'default query is ordered by start date');
	assert(career.headers.join(',') === 'company,role,period', 'default columns are correct');

	await clickExample('impact', 'Pipeline runtime');
	await clickExample('go', 'Go');
	await clickExample('stack', 'Languages');
	const count = await clickExample('count', 'projects');
	assert(count.rows.length === 1 && count.rows[0][0] === '3', 'aggregate count returns 3 projects');

	// Free-form query
	await evaluate(`(() => {
		const input = document.getElementById('console-input');
		input.value = 'SELECT name, stat FROM projects ORDER BY year DESC';
		document.getElementById('console-form').requestSubmit();
	})()`);
	await waitFor(
		`document.querySelector('#console-output').textContent.includes('41% lower insert latency')`,
		'free-form query'
	);
	const freeForm = await readOutput();
	assert(freeForm.headers.join(',') === 'name,stat', 'free-form query columns are correct');
	assert(freeForm.rows.length === 3, 'free-form query returns all projects');

	// Read-only guard
	await evaluate(`(() => {
		const input = document.getElementById('console-input');
		input.value = 'DELETE FROM experience';
		document.getElementById('console-form').requestSubmit();
	})()`);
	await waitFor(
		`Boolean(document.querySelector('#console-output .console-error'))`,
		'read-only error'
	);
	const guarded = await readOutput();
	assert(/read-only/i.test(guarded.error || ''), 'write statements are rejected');

	// Tabs
	await evaluate(`document.getElementById('tab-schema').click()`);
	assert(
		await evaluate(`!document.getElementById('panel-schema').hidden`),
		'schema tab shows schema panel'
	);
	assert(
		await evaluate(`document.getElementById('panel-query').hidden`),
		'schema tab hides query panel'
	);
	await evaluate(`document.getElementById('tab-query').click()`);
	assert(
		await evaluate(`!document.getElementById('panel-query').hidden`),
		'query tab restores query panel'
	);

	// Mobile layout must not create document-level horizontal scroll.
	await send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await sleep(500);
	const overflow = await evaluate(`JSON.stringify({
		innerWidth: window.innerWidth,
		doc: document.documentElement.scrollWidth,
		body: document.body.scrollWidth
	})`);
	const sizes = JSON.parse(overflow);
	assert(sizes.doc <= sizes.innerWidth, 'no horizontal overflow at 390px (doc=' + sizes.doc + ')');

	// Asset checks
	for (const asset of [
		'/cv.html',
		'/assets/Lee-Ngari-CV.pdf',
		'/assets/og.png',
		'/assets/favicon.svg',
		'/data/content.json',
	]) {
		const response = await fetch(base + asset);
		assert(response.ok, 'asset responds: ' + asset);
	}

	assert(pageErrors.length === 0, 'no browser console errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));

	console.log('\nAll checks passed.');
}

main()
	.catch((error) => {
		console.error('\n' + error.message);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			ws?.close();
		} catch {
			/* ignore */
		}
		proc.kill();
	});
