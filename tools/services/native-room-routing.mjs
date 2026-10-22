// Fixed, bounded routing shared by the local WebSocket adapter and Worker.
// Legacy room codes keep their own coordinator and never select a shard.
export const NATIVE_ROOM_SHARDS = 8;
export const NATIVE_SHARD_MAX_CLIENTS = 16;
export const NATIVE_SHARD_MAX_ROOMS = 8;
export const NATIVE_ROOM_ROUTING = Object.freeze({
  shards:NATIVE_ROOM_SHARDS,
  maxClientsPerShard:NATIVE_SHARD_MAX_CLIENTS,
  maxRoomsPerShard:NATIVE_SHARD_MAX_ROOMS,
});

function validShard(shard) {
  if(shard!==null&&(!Number.isInteger(shard)||shard<0||shard>=NATIVE_ROOM_SHARDS))throw new Error('Invalid native room shard');
  return shard;
}

export function parseNativeRoomShard(url) {
  const params=(url instanceof URL?url:new URL(url)).searchParams;
  const values=params.getAll('shard');
  for(const key of params.keys())if(key!=='shard')throw new Error('Invalid native room query');
  if(!values.length)return null;
  if(values.length!==1||!/^[0-7]$/.test(values[0]))throw new Error('Invalid native room shard');
  return Number(values[0]);
}

export function nativeRoomObjectName(shard) {
  return validShard(shard)===null?'native-v3':`native-v3-shard-${shard}`;
}

export function nativeRoomCoordinatorOptions(shard) {
  return validShard(shard)===null?{}:{
    maxClients:NATIVE_SHARD_MAX_CLIENTS,
    maxRooms:NATIVE_SHARD_MAX_ROOMS,
    codePrefix:`S${shard}`,
  };
}
