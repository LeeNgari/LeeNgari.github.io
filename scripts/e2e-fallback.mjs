// Verifies the no-WebAssembly fallback path.
// Usage: node scripts/e2e-fallback.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 9225;
const profile = path.join(os.tmpdir(), 'edge-e2e-fallback-' + Date.now());
const base = process.env.BASE_URL || 'http://127.0.0.1:4173';
const edge = [
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => fs.existsSync(candidate));
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
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
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
	return JSON.parse(
		await evaluate(`(() => JSON.stringify({
			meta: document.querySelector('#console-output .console-meta')?.textContent || null,
			error: document.querySelector('#console-output .console-error')?.textContent || null,
			rows: [...document.querySelectorAll('#console-output tbody tr')].map((row) =>
				[...row.children].map((cell) => cell.textContent))
		}))()`)
	);
}

async function main() {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
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
		}
	});

	await send('Page.enable');
	await send('Runtime.enable');
	await send('Network.enable');
	await send('Network.setBlockedURLs', { urls: ['*joydb.wasm*'] });
	await send('Emulation.setDeviceMetricsOverride', {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});

	await send('Page.navigate', { url: base + '/#joydb' });
	await waitFor(
		`document.getElementById('console-status-text') && document.getElementById('console-status-text').textContent === 'FALLBACK'`,
		'fallback state',
		25000
	);
	assert(true, 'console enters FALLBACK when the WASM request is blocked');

	await waitFor(
		`document.querySelectorAll('#console-output tbody tr').length === 3`,
		'fallback career rows'
	);
	const career = await readOutput();
	assert(career.rows[0][0] === 'Microsoft', 'fallback renders career data');
	assert(/static fallback/.test(career.meta || ''), 'fallback result is labelled');
	assert(
		/WebAssembly is unavailable/.test(
			await evaluate(`document.getElementById('console-note').textContent`)
		),
		'fallback explanation is shown'
	);

	assert(
		await evaluate(`document.getElementById('console-reset').disabled`),
		'reset is disabled in fallback'
	);
	assert(
		await evaluate(`document.getElementById('visitor-name').disabled`),
		'visitor form is disabled in fallback'
	);
	assert(
		await evaluate(`document.getElementById('visitor-form').querySelector('button[type="submit"]').disabled`),
		'visitor submit is disabled in fallback'
	);
	assert(
		/WebAssembly/.test(await evaluate(`document.getElementById('visitor-status').textContent`)),
		'visitor form explains why it is disabled'
	);

	await waitFor(
		`document.querySelector('[data-count="experience"]').textContent === '3'`,
		'fallback table counts'
	);
	assert(
		(await evaluate(`document.querySelector('[data-count="visitors"]').textContent`)) === '1',
		'fallback visitor count is correct'
	);

	await evaluate(`document.querySelector('[data-example="impact"]').click()`);
	await waitForOutput('Pipeline runtime', 'fallback impact query');
	const impact = await readOutput();
	assert(impact.rows.length === 5, 'fallback join returns 5 rows');
	assert(/static fallback/.test(impact.meta || ''), 'fallback join is labelled');

	await evaluate(`document.querySelector('[data-table="projects"]').click()`);
	await waitForOutput('Watch Party', 'fallback table browser');
	const table = await readOutput();
	assert(table.rows.length === 3, 'fallback table browser returns all projects');
	assert(
		(await evaluate(`document.getElementById('console-input').value`)) === 'SELECT * FROM projects',
		'fallback table browser fills the query'
	);

	await evaluate(`document.querySelector('[data-example="visitors"]').click()`);
	await waitForOutput('i live here.', 'fallback visitors query');
	const visitors = await readOutput();
	assert(visitors.rows.length === 1, 'fallback visitors query returns the seed row');

	console.log('\nAll fallback checks passed.');
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
