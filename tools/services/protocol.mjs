const COMMAND_KINDS = new Set(['select', 'move', 'attack', 'deploy', 'queue', 'produce', 'place', 'cancel', 'cancelProduction', 'stop', 'guard', 'sell', 'repair', 'scatter', 'attackMove', 'forceAttack']);
export function ensure(condition, message) { if (!condition) throw new Error(message); }
export function isStateHash(value) { return typeof value === 'string' && /^[\da-z:_-]{1,128}$/i.test(value); }
/** The transport supplies compact human identity; a browser cannot choose another player. */
export function bindCommands(value, player) {
  ensure(Array.isArray(value) && value.length <= 256, '每帧最多提交 256 条指令');
  return value.map(command => {
    ensure(command && typeof command === 'object' && !Array.isArray(command) && COMMAND_KINDS.has(command.kind), '不支持的作战指令');
    return { ...JSON.parse(JSON.stringify(command)), player };
  });
}
