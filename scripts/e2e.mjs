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

async function waitForOutput(text, label = text) {
	await waitFor(
		`document.getElementById('console-output').textContent.includes(${JSON.stringify(text)})`,
		label
	);
}

function assert(condition, label) {
	if (!condition) throw new Error('FAIL: ' + label);
	console.log('PASS: ' + label);
}

async function readOutput() {
	const raw = await evaluate(`(() => {
		const meta = document.querySelector('#console-output .console-meta');
		const error = document.querySelector('#console-output .console-error');
		const write = document.querySelector('#console-output .write-result');
		const rows = [...document.querySelectorAll('#console-output tbody tr')];
		return JSON.stringify({
			meta: meta ? meta.textContent : null,
			error: error ? error.textContent : null,
			write: write ? write.textContent : null,
			rows: rows.map((row) => [...row.children].map((cell) => cell.textContent)),
			headers: [...document.querySelectorAll('#console-output th')].map((th) => th.textContent),
		});
	})()`);
	return JSON.parse(raw);
}

async function submitSQL(sql) {
	await evaluate(`(() => {
		const input = document.getElementById('console-input');
		input.value = ${JSON.stringify(sql)};
		document.getElementById('console-form').requestSubmit();
	})()`);
}

async function clickExample(id, expectedText) {
	await evaluate(`document.querySelector('[data-example="${id}"]').click()`);
	await waitForOutput(expectedText, 'example ' + id);
	const output = await readOutput();
	assert(output.rows.length > 0, `example ${id} returns rows`);
	assert(!output.error, `example ${id} has no error`);
	return output;
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
	await evaluate(`document.documentElement.style.scrollBehavior = 'auto';
		document.getElementById('joydb').scrollIntoView();`);
	await waitFor('window.JoyDB && window.JoyDB.ready', 'JoyDB boot in browser', 30000);

	const status = await evaluate(`document.getElementById('console-status-text').textContent`);
	assert(/^READY/.test(status), 'console reports READY (' + status + ')');
	const bootMatch = status.match(/(\d+)\s*MS/i);
	assert(Boolean(bootMatch) && Number(bootMatch[1]) > 0, 'boot time is not displayed as zero');
	assert(
		(await evaluate(`document.getElementById('console-reset').disabled`)) === false,
		'reset control is enabled after boot'
	);
	assert(
		(await evaluate(`document.getElementById('visitor-name').disabled`)) === false,
		'visitor form is enabled after boot'
	);

	const career = await readOutput();
	assert(career.rows.length === 3, 'default career query returns 3 rows');
	assert(career.rows[0][0] === 'Microsoft', 'default query is ordered by start date');
	assert(career.headers.join(',') === 'company,role,period', 'default columns are correct');

	await clickExample('impact', 'Pipeline runtime');
	await clickExample('go', 'Go');
	await clickExample('stack', 'Languages');
	await clickExample('visitors', 'i live here.');
	const count = await clickExample('count', 'projects');
	assert(count.rows.length === 1 && count.rows[0][0] === '3', 'aggregate count returns 3 projects');

	// Free-form query
	await submitSQL('SELECT name, stat FROM projects ORDER BY year DESC');
	await waitForOutput('41% lower insert latency', 'free-form query');
	const freeForm = await readOutput();
	assert(freeForm.headers.join(',') === 'name,stat', 'free-form query columns are correct');
	assert(freeForm.rows.length === 3, 'free-form query returns all projects');

	// Table browser
	await evaluate(`document.querySelector('[data-table="projects"]').click()`);
	await waitForOutput('Watch Party', 'table browser query');
	const tableResult = await readOutput();
	assert(tableResult.rows.length === 3, 'table browser selects the projects table');
	assert(
		(await evaluate(`document.getElementById('console-input').value`)) === 'SELECT * FROM projects',
		'table browser fills the query input'
	);

	// DDL is blocked in the UI
	await submitSQL('DROP TABLE experience');
	await waitFor(`Boolean(document.querySelector('#console-output .console-error'))`, 'DDL error');
	const ddl = await readOutput();
	assert(/DDL is disabled/.test(ddl.error || ''), 'DDL statements are rejected');

	// Writes are allowed
	await submitSQL(
		"INSERT INTO visitors (id, name, note, created_at) VALUES (99, 'E2E', 'write test', '2026-10-22')"
	);
	await waitFor(`Boolean(document.querySelector('#console-output .write-result'))`, 'write result');
	const written = await readOutput();
	assert(/INSERT/.test(written.write || ''), 'INSERT returns a write result');
	assert(/1 row affected/.test(written.write || ''), 'INSERT reports one affected row');

	await submitSQL('SELECT COUNT(*) AS n FROM visitors');
	await waitFor(`document.querySelector('#console-output .console-meta') && document.querySelector('#console-output .console-meta').textContent.includes('1 row')`, 'visitor count after insert');
	const afterWrite = await readOutput();
	assert(afterWrite.rows.length === 1 && afterWrite.rows[0][0] === '2', 'write changed the visitor count');

	// Visitor form
	await evaluate(`document.getElementById('tab-schema').click()`);
	await evaluate(`(() => {
		document.getElementById('visitor-name').value = 'Ada';
		document.getElementById('visitor-note').value = 'hello from the browser';
		document.getElementById('visitor-form').requestSubmit();
	})()`);
	await waitForOutput('Ada', 'visitor form insert');
	const visitorResult = await readOutput();
	assert(
		visitorResult.rows.some((row) => row.includes('Ada')),
		'visitor form inserts a row and shows it'
	);
	assert(
		(await evaluate(`document.getElementById('tab-query').getAttribute('aria-selected')`)) === 'true',
		'visitor form switches to the query tab'
	);
	assert(
		(await evaluate(`document.querySelector('[data-count="visitors"]').textContent`)) === '3',
		'table counts update after a write'
	);

	// Reset
	await evaluate(`document.getElementById('console-reset').click()`);
	await waitForOutput('Microsoft', 'reset career query');
	await submitSQL('SELECT COUNT(*) AS n FROM visitors');
	await waitFor(
		`document.querySelector('#console-output tbody tr td') && document.querySelector('#console-output tbody tr td').textContent === '1'`,
		'reset visitor count'
	);
	const resetCount = await readOutput();
	assert(resetCount.rows[0][0] === '1', 'reset restores the seeded visitor');
	assert(
		(await evaluate(`document.querySelector('[data-count="visitors"]').textContent`)) === '1',
		'table counts update after reset'
	);

	// Tables tab has the new schema
	await evaluate(`document.getElementById('tab-schema').click()`);
	assert(
		await evaluate(
			`document.getElementById('panel-schema').textContent.includes('CREATE TABLE visitors')`
		),
		'tables panel shows the visitors schema'
	);
	await evaluate(`document.getElementById('tab-query').click()`);
	assert(
		await evaluate(`!document.getElementById('panel-query').hidden`),
		'query tab restores the query panel'
	);

	// Mobile layout must not create document-level horizontal scroll.
	await send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await sleep(500);
	const sizes = JSON.parse(
		await evaluate(`JSON.stringify({
			innerWidth: window.innerWidth,
			doc: document.documentElement.scrollWidth,
			body: document.body.scrollWidth
		})`)
	);
	assert(sizes.doc <= sizes.innerWidth, 'no horizontal overflow at 390px (doc=' + sizes.doc + ')');

	// Asset checks
	for (const asset of [
		'/cv.html',
		'/assets/LeeNgari_Resume.pdf',
		'/assets/og.png',
		'/assets/favicon.svg',
		'/data/content.json',
	]) {
		const response = await fetch(base + asset);
		assert(response.ok, 'asset responds: ' + asset);
	}

	assert(
		pageErrors.length === 0,
		'no browser console errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : '')
	);

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
