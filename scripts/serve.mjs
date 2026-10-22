// Minimal static server with correct WASM MIME type for local development.
// Usage: node scripts/serve.mjs [port]

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 4173);

const types = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((request, response) => {
	const url = new URL(request.url, 'http://localhost');
	let pathname = decodeURIComponent(url.pathname);
	if (pathname.endsWith('/')) pathname += 'index.html';

	const file = path.resolve(root, '.' + pathname);
	const relative = path.relative(root, file);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		response.writeHead(403, { 'Content-Type': 'text/plain' });
		response.end('Forbidden');
		return;
	}

	if (!existsSync(file) || !statSync(file).isFile()) {
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('Not found: ' + pathname);
		return;
	}

	response.writeHead(200, {
		'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
		'Cache-Control': 'no-cache',
	});
	createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
	console.log(`Serving ${root}`);
	console.log(`http://127.0.0.1:${port}/`);
});
