export interface HumanPlayerInfo {
  name: string;
}

export function isHumanPlayerInfo(playerInfo: object): playerInfo is HumanPlayerInfo {
  return 'name' in playerInfo;
}

export enum AiDifficulty {
  Brutal = 0,
  Medium = 1,
  Easy = 2,
  MediumSea = 3,
  Advanced = 4,
}
