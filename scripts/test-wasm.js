// Headless smoke test for the JoyDB WebAssembly build.
// Run from the repo root: node scripts/test-wasm.js

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
require(path.join(root, 'wasm', 'wasm_exec.js'));

const go = new Go();
const wasm = fs.readFileSync(path.join(root, 'wasm', 'joydb.wasm'));

const queries = [
	'SELECT company, role, period FROM experience ORDER BY start_date DESC',
	'SELECT e.company, m.label, m.value FROM experience e INNER JOIN metrics m ON e.id = m.experience_id ORDER BY e.id',
	"SELECT name, stack FROM projects WHERE language = 'Go'",
	'SELECT COUNT(*) AS projects FROM projects',
	'SELECT category, items FROM stack ORDER BY id',
	'DELETE FROM experience',
];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	const result = await WebAssembly.instantiate(wasm, go.importObject);
	go.run(result.instance); // resolves only if the Go program exits

	const deadline = Date.now() + 15000;
	while (!globalThis.JoyDB && Date.now() < deadline) {
		await sleep(50);
	}

	if (!globalThis.JoyDB) {
		throw new Error('JoyDB global never appeared');
	}
	if (!globalThis.JoyDB.ready) {
		throw new Error('JoyDB failed to boot: ' + globalThis.JoyDB.initError);
	}

	console.log(`JoyDB ready in ${globalThis.JoyDB.bootMs.toFixed(1)} ms`);

	for (const sql of queries) {
		const response = JSON.parse(globalThis.JoyDB.query(sql));
		console.log('\n> ' + sql);
		console.log(JSON.stringify(response, null, 2));
	}

	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
