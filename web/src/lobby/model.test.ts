import { strict as assert } from 'node:assert';
import { defaultConfig, sanitizeConfig, validateConfig, loadConfig, RANDOM } from './model';
import type { LobbyCatalog } from '../ui/types';
const catalog: LobbyCatalog = {
  maps: [{ id: 'wide', name: '八人地图', maxPlayers: 8 }, { id: 'small', name: '双人地图', maxPlayers: 2 }],
  countries: [{ id: 'America', name: '美国' }, { id: 'Russia', name: '苏俄' }],
  colors: [{ id: 0, name: '黄色', hex: '#ffdf00' }, { id: 1, name: '红色', hex: '#fe3333' }, { id: 2, name: '蓝色', hex: '#3183ff' }],
};
const checks: Array<[string, () => void]> = [
  ['map changes close overflow slots and reset invalid fixed starts', () => {
    const config = defaultConfig(); config.mapId = 'small';
    config.slots[0].start = 7; config.slots[3].kind = 'ai';
    const result = sanitizeConfig(config, catalog);
    assert.equal(result.slots[0].start, RANDOM); assert.equal(result.slots[3].kind, 'closed');
    assert.equal(config.slots[3].kind, 'ai', 'sanitizing does not mutate saved room configuration');
  }],
  ['duplicate starts and colors become seeded random choices', () => {
    const config = defaultConfig(); config.mapId = 'wide';
    config.slots[0].color = 1; config.slots[1].color = 1;
    config.slots[0].start = 0; config.slots[1].start = 0;
    const result = sanitizeConfig(config, catalog);
    assert.equal(result.slots[0].color, 1); assert.equal(result.slots[1].color, RANDOM);
    assert.equal(result.slots[0].start, 0); assert.equal(result.slots[1].start, RANDOM);
  }],
  ['remembered missing map and country recover to supported choices', () => {
    const config = defaultConfig(); config.mapId = 'removed'; config.slots[0].country = 'Unsupported';
    const result = sanitizeConfig(config, catalog); assert.equal(result.mapId, 'wide'); assert.equal(result.slots[0].country, 'America');
  }],
  ['native speed values remain zero to six and bounded inputs recover', () => {
    const config = defaultConfig(); config.gameSpeed = 99; config.seed = -1; config.unitCount = -3; config.credits = Infinity;
    const result = sanitizeConfig(config, catalog);
    assert.equal(result.gameSpeed, 6); assert.equal(result.seed, 0xffffffff); assert.equal(result.unitCount, 0); assert.equal(result.credits, 10000);
  }],
  ['single player cannot start alone or with every opponent allied', () => {
    const config = sanitizeConfig(defaultConfig(), catalog); assert.equal(validateConfig(config, catalog), null);
    config.slots[1].kind = 'closed'; assert.match(validateConfig(config, catalog) ?? '', /电脑对手/);
    config.slots[1].kind = 'ai'; config.slots[0].team = 0; config.slots[1].team = 0;
    assert.match(validateConfig(config, catalog) ?? '', /不同阵营/); config.slots[1].team = RANDOM;
    assert.equal(validateConfig(config, catalog), null);
  }],
  ['a guest human stays human through config normalization', () => {
    const config = defaultConfig(); config.slots[1].kind = 'human'; config.slots[1].name = '朋友';
    const result = sanitizeConfig(config, catalog); assert.equal(result.slots[1].kind, 'human'); assert.equal(result.slots[1].name, '朋友');
  }],
  ['reloading a saved room restores absent humans as computer opponents', () => {
    const config=defaultConfig();config.slots[1].kind='human';
    const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>JSON.stringify(config)}});
    try {const restored=loadConfig();assert.equal(restored.slots[0].kind,'human');assert.equal(restored.slots[1].kind,'ai');}
    finally {if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');}
  }],
];
for (const [name, check] of checks) { check(); console.log(`PASS ${name}`); }
console.log(`${checks.length} lobby checks passed`);
