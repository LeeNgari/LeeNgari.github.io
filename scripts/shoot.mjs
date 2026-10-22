// Full-page screenshot helper for local visual QA.
// Usage: node scripts/shoot.mjs <width> <outfile> [url]
// Requires Microsoft Edge on Windows.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const width = Number(process.argv[2] || 1440);
const outfile = process.argv[3] || 'shot.png';
const url = process.argv[4] || 'http://127.0.0.1:4173/#joydb';
const port = 9223;
const profile = path.join(os.tmpdir(), 'edge-cdp-' + Date.now());

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
		'--hide-scrollbars',
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

async function waitForDevTools() {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return;
		} catch {
			/* not ready yet */
		}
		await sleep(200);
	}
	throw new Error('DevTools endpoint did not start');
}

async function main() {
	await waitForDevTools();

	const targetResponse = await fetch(
		`http://127.0.0.1:${port}/json/new?` + encodeURIComponent(url),
		{ method: 'PUT' }
	);
	const target = await targetResponse.json();

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
	await send('Emulation.setDeviceMetricsOverride', {
		width,
		height: 900,
		deviceScaleFactor: 1,
		mobile: width < 700,
	});

	await sleep(1200);
	await send('Runtime.evaluate', {
		expression: 'document.fonts.ready',
		awaitPromise: true,
	});

	if (!/cv\.html|404\.html/.test(url)) {
		for (let i = 0; i < 150; i++) {
			const ready = await send('Runtime.evaluate', {
				expression: 'Boolean(window.JoyDB && window.JoyDB.ready)',
				returnByValue: true,
			});
			if (ready.result.value) break;
			await sleep(100);
		}
	}
	await sleep(300);

	// Return to the top so sticky/fixed elements are captured once, at their real position.
	await send('Runtime.evaluate', {
		expression: `
			document.documentElement.style.scrollBehavior = 'auto';
			if (location.hash) history.replaceState(null, '', location.pathname);
			window.scrollTo(0, 0);
			if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
		`,
	});
	await sleep(700);

	const metrics = await send('Page.getLayoutMetrics');
	const size = metrics.cssContentSize || metrics.contentSize;
	const shot = await send('Page.captureScreenshot', {
		format: 'png',
		captureBeyondViewport: true,
		clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
	});

	fs.writeFileSync(outfile, Buffer.from(shot.data, 'base64'));
	console.log(`Wrote ${outfile} (${size.width}×${Math.round(size.height)})`);
}

main()
	.catch((error) => {
		console.error(error);
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
