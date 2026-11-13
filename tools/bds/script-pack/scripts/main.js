import { BlockPermutation, BlockStates, BlockTypes, system, world } from '@minecraft/server';
import { permutations } from './permutations.js';

// One log line per resolved permutation, read back by tools/bds/script.js. The job yields
// after each one, so the watchdog never sees a long tick.
const api = { resolve: (id, states) => BlockPermutation.resolve(id, states), values: (name) => BlockStates.get(name).validValues };

function* measure() {
	let [states, refused] = [0, 0];
	try {
		const types = BlockTypes.getAll();
		for (const t of types) {
			for (const p of permutations(t.id, api)) {
				if (p) console.log(`RIFTAL_STATE ${JSON.stringify({ name: t.id, states: p })}`);
				p ? states++ : refused++;
				yield;
			}
		}
		console.log(`RIFTAL_DONE ${JSON.stringify({ types: types.length, states, refused })}`);
	} catch (e) {
		console.log(`RIFTAL_ERROR ${JSON.stringify(String(e))}`);
	}
}

world.afterEvents.worldLoad.subscribe(() => system.runJob(measure()));
