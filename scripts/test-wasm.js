// Headless smoke test for the JoyDB WebAssembly build.
// Run from the repo root: node scripts/test-wasm.js

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
require(path.join(root, 'wasm', 'wasm_exec.js'));

const go = new Go();
const wasm = fs.readFileSync(path.join(root, 'wasm', 'joydb.wasm'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

function assert(condition, label) {
	if (condition) {
		console.log('PASS: ' + label);
	} else {
		failures += 1;
		console.error('FAIL: ' + label);
	}
}

async function main() {
	const result = await WebAssembly.instantiate(wasm, go.importObject);
	go.run(result.instance); // resolves only if the Go program exits

	const deadline = Date.now() + 15000;
	while (!globalThis.JoyDB && Date.now() < deadline) await sleep(50);

	if (!globalThis.JoyDB) throw new Error('JoyDB global never appeared');
	if (!globalThis.JoyDB.ready) {
		throw new Error('JoyDB failed to boot: ' + globalThis.JoyDB.initError);
	}
	console.log(`JoyDB ready in ${globalThis.JoyDB.bootMs.toFixed(1)} ms`);

	const call = (method, ...args) => JSON.parse(globalThis.JoyDB[method](...args));

	const career = call('query', 'SELECT company, role, period FROM experience ORDER BY start_date DESC');
	assert(career.ok && career.rows.length === 3, 'career query returns 3 rows');
	assert(career.rows[0][0] === 'Microsoft', 'career query is ordered by start date');

	const impact = call(
		'query',
		'SELECT e.company, m.label, m.value FROM experience AS e INNER JOIN metrics AS m ON e.id = m.experience_id ORDER BY e.id'
	);
	assert(impact.ok && impact.rows.length === 5, 'JOIN returns 5 metric rows');

	const goProjects = call('query', "SELECT name, stack FROM projects WHERE language = 'Go'");
	assert(goProjects.ok && goProjects.rows.length === 1, 'filter query returns one Go project');

	const count = call('query', 'SELECT COUNT(*) AS projects FROM projects');
	assert(count.ok && count.rows[0][0] === 3, 'aggregate count returns 3');

	const visitorsBefore = call('query', 'SELECT COUNT(*) AS n FROM visitors');
	assert(visitorsBefore.ok && visitorsBefore.rows[0][0] === 1, 'visitors table starts with 1 row');

	const inserted = call(
		'exec',
		"INSERT INTO visitors (id, name, note, created_at) VALUES (99, 'Test', 'smoke', '2026-10-22')"
	);
	assert(inserted.ok && inserted.rowsAffected === 1, 'exec inserts a visitor');

	const added = call('addVisitor', 'Node', 'smoke test');
	assert(added.ok && added.id === 100, 'addVisitor uses the next id');

	const visitorsAfter = call('query', 'SELECT COUNT(*) AS n FROM visitors');
	assert(visitorsAfter.ok && visitorsAfter.rows[0][0] === 3, 'visitor count reflects both inserts');

	const writeRejected = call('query', 'DELETE FROM visitors');
	assert(!writeRejected.ok && /SELECT only/.test(writeRejected.error), 'query endpoint rejects writes');

	const ddlRejected = call('exec', 'DROP TABLE visitors');
	assert(!ddlRejected.ok && /INSERT, UPDATE, or DELETE/.test(ddlRejected.error), 'exec endpoint rejects DDL');

	const reset = call('reset');
	assert(reset.ok, 'reset succeeds');

	const visitorsReset = call('query', 'SELECT COUNT(*) AS n FROM visitors');
	assert(visitorsReset.ok && visitorsReset.rows[0][0] === 1, 'reset restores the seeded visitor');

	const careerReset = call('query', 'SELECT COUNT(*) AS n FROM experience');
	assert(careerReset.ok && careerReset.rows[0][0] === 3, 'reset restores the core data');

	if (failures) {
		console.error(`\n${failures} check(s) failed.`);
		process.exit(1);
	}
	console.log('\nAll engine checks passed.');
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
