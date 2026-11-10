import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEAM_PRESETS, normalizePersonas } from '../lib/personas.js';

const home = (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
const dir = path.join(home, 'quorum');
fs.mkdirSync(dir, { recursive: true });

const { personas, warnings } = normalizePersonas(TEAM_PRESETS.product_squad);
const file = path.join(dir, 'personas.json');
fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), personas }, null, 2), 'utf8');
console.log('wrote', file, 'seats', personas.map((p) => p.name).join(' / '), warnings.length ? `warnings=${warnings.join(';')}` : '');
