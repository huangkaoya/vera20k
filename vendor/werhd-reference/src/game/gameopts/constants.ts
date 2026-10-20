import { AiDifficulty } from './GameOpts';

export const RANDOM_COUNTRY_ID = -2;
export const RANDOM_COLOR_ID = -2;
export const RANDOM_START_POS = -2;
export const NO_TEAM_ID = -2;
export const OBS_COUNTRY_ID = -3;
export const OBS_COLOR_ID = -2;
export const RANDOM_COUNTRY_NAME = 'Random';
export const OBS_COUNTRY_NAME = 'Observer';
export const aiUiNames = new Map<AiDifficulty, string>()
  .set(AiDifficulty.Easy, 'GUI:AIDummy')
  .set(AiDifficulty.Medium, 'GUI:AIEasyBeta')
  .set(AiDifficulty.MediumSea, 'GUI:AISeaLand')
  .set(AiDifficulty.Advanced, 'GUI:AIAdvanced');
export const aiEnglishNames: ReadonlyMap<number, string> = new Map<AiDifficulty, string>()
  .set(AiDifficulty.Brutal, 'Brutal AI')
  .set(AiDifficulty.Easy, 'Training Dummy')
  .set(AiDifficulty.Medium, 'Easy Enemy')
  .set(AiDifficulty.MediumSea, 'Sea/Land Enemy')
  .set(AiDifficulty.Advanced, 'Advanced AI');
export const aiUiTooltips = new Map<string, string>();
export const RANDOM_COUNTRY_UI_NAME = 'GUI:RandomEx';
export const RANDOM_COUNTRY_UI_TOOLTIP = 'STT:PlayerSideRandom';
export const OBS_COUNTRY_UI_NAME = 'GUI:Observer';
export const OBS_COUNTRY_UI_TOOLTIP = 'STT:PlayerSideObserver';
export const RANDOM_COLOR_NAME = '';
