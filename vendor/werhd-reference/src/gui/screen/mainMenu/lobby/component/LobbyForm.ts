import { RACE_REPAIR_COST, RACE_CHECKPOINT_REWARD } from "../../../../../game/race/RaceBalance";
import classNames from 'classnames';
import React from 'react';
import * as GameOptsModule from '../../../../../game/gameopts/GameOpts';
import * as ConstantsModule from '../../../../../game/gameopts/constants';
import * as TypeGuardModule from '../../../../../util/typeGuard';
import * as ChatModule from '../../../../component/Chat';
import * as ColorSelectModule from '../../../../component/ColorSelect';
import * as CountrySelectModule from '../../../../component/CountrySelect';
import * as ImageModule from '../../../../component/Image';
import * as OptionModule from '../../../../component/Option';
import * as PingIndicatorModule from '../../../../component/PingIndicator';
import * as SelectModule from '../../../../component/Select';
import * as SliderModule from '../../../../component/Slider';
import * as StartPosSelectModule from '../../../../component/StartPosSelect';
import * as TeamSelectModule from '../../../../component/TeamSelect';
import * as LobbyModel from './viewmodel/lobby';
import * as RankIndicatorModule from './RankIndicator';
import { resolveRaceSettings, type RaceSettings } from '../../../../../game/race/RaceSettings';
import { formatDisplayNickname } from '../../../../../util/nicknameCodec';

const l = { default: React };
const n = { default: classNames };
const c = LobbyModel;
const o = SliderModule;
const h = ChatModule;
const a = CountrySelectModule;
const u = ColorSelectModule;
const d = PingIndicatorModule;
const g = GameOptsModule;
const i = ImageModule;
const p = StartPosSelectModule;
const m = TeamSelectModule;
const f = ConstantsModule;
const y = SelectModule;
const T = OptionModule;
const v = TypeGuardModule;
const b = RankIndicatorModule;
class r extends l.default.Component<LobbyModel.LobbyFormProps> {
  declare readonly onPlayerSelect: (value: string, slotIndex: number) => void;

  constructor(props: LobbyModel.LobbyFormProps, context?: unknown) {
    (super(props, context),
      (this.onPlayerSelect = (e: string, t: number) => {
        let i: LobbyModel.SlotOccupation, r: GameOptsModule.AiDifficulty | undefined;
        (e.match(/^\d+$/)
          ? (i = Number(e) as LobbyModel.SlotOccupation)
          : ((i = c.SlotOccupation.Occupied),
            (r = g.AiDifficulty[e as keyof typeof g.AiDifficulty] as GameOptsModule.AiDifficulty)),
          this.props.onSlotChange(i, t, r));
      }));
  }
  private renderRaceRules(): React.ReactNode {
    const props = this.props, settings = resolveRaceSettings(props.raceSettings);
    const host = props.lobbyType === c.LobbyType.Singleplayer || props.lobbyType === c.LobbyType.MultiplayerHost;
    const columnStyle: React.CSSProperties = { float: 'none', display: 'flex', flexDirection: 'column', width: '50%', height: 'auto', paddingTop: 0, gap: 8 };
    const option = (label: string, name: keyof RaceSettings, values: number[], suffix: string) =>
      React.createElement('div', { className: 'slider-item' },
        React.createElement('span', { className: 'label' }, label),
        React.createElement(y.Select, { initialValue: String(settings[name]), disabled: !host,
          onSelect: (value: string) => props.onChangeRaceSettings?.({ ...settings, [name]: Number(value) }) },
          ...values.map(value => React.createElement(T.Option, { key: value, label: `${value}${suffix}`, value: String(value) }))));
    return React.createElement('div', { className: 'race-lobby-rules' },
      React.createElement('div', { className: 'game-options', style: { display: 'flex', gap: 24, margin: '12px 24px' } },
        React.createElement('div', { className: 'game-options-left', style: columnStyle },
          option('比赛圈数', 'laps', [1, 2, 3, 5, 7, 9], ' 圈'),
          option('重生等待', 'respawnSeconds', [2, 3, 5, 10], ' 秒')),
        React.createElement('div', { className: 'game-options-right', style: columnStyle },
          React.createElement('div', { className: 'slider-item' }, React.createElement('span', { className: 'label' }, '初始资金'),
            React.createElement(y.Select, { initialValue: String(props.credits), disabled: !host,
              onSelect: (value: string) => props.onChangeCredits(Number(value)) },
              ...[...new Set([0, 1000, 5000, 10000, 20000, 50000, props.credits])].sort((a,b) => a-b).map(value => React.createElement(T.Option, { key: value, label: String(value), value: String(value) })))),
          option('木箱刷新', 'crateSeconds', [3, 6, 10, 15, 30], ' 秒'))),
      React.createElement('div', { style: { padding: '4px 24px', lineHeight: 1.7 } },
        React.createElement('strong', null, `${settings.laps} 圈竞速 · 自由选路`),
        React.createElement('div', null, '选择国家即选择固定坦克。依次通过 8 个游标计一圈；落水、翻车或耐久耗尽后从最后通过的游标重生。'),
        React.createElement('div', null, `每个游标奖励 ${RACE_CHECKPOINT_REWARD} 资金。驶入维修厂并刹停，每点耐久消耗 ${RACE_REPAIR_COST} 资金；油门可中止维修。`),
        React.createElement('div', null, 'WASD 驾驶 · 刹车＋转向漂移 / 空中侧倾 · E 技能 · 空格道具')));
  }
  render(): React.ReactNode {
    let { strings: e, lobbyType: t, mpDialogSettings: i } = this.props;
    var r = t === c.LobbyType.Singleplayer || t === c.LobbyType.MultiplayerHost,
      s = t === c.LobbyType.Singleplayer;
    let a = this.props;
    return l.default.createElement(
      'div',
      {
        className: n.default('lobby-form', {
          'lobby-form-sp': s,
          'lobby-form-race': a.raceMode,
          'lobby-form-server-sel': a.selectedGameServer,
        }),
      },
      a.selectedGameServer &&
        l.default.createElement(
          'div',
          {
            className: 'game-server',
          },
          l.default.createElement(
            'span',
            {
              className: 'label',
            },
            e.get('TS:ServerLabel'),
          ),
          l.default.createElement(
            y.Select,
            {
              initialValue: a.selectedGameServer,
              disabled: !0,
            },
            l.default.createElement(T.Option, {
              label: a.selectedGameServer,
              value: a.selectedGameServer,
            }),
          ),
        ),
      l.default.createElement(
        'div',
        {
          className: 'player-slots',
        },
        l.default.createElement(
          'div',
          {
            className: 'player-slot player-slot-header',
          },
          l.default.createElement(
            'div',
            {
              className: 'player-header-players',
            },
            e.get('GUI:Players'),
          ),
          l.default.createElement(
            'div',
            {
              className: 'player-header-side',
            },
            e.get('GUI:Side'),
          ),
          l.default.createElement(
            'div',
            {
              className: 'player-header-color',
            },
            e.get('GUI:Color'),
          ),
          l.default.createElement(
            'div',
            {
              className: 'player-header-position',
            },
            e.get('GUI:StartPosition'),
          ),
          l.default.createElement(
            'div',
            {
              className: 'player-header-team',
            },
            e.get('GUI:Team'),
          ),
        ),
        a.playerSlots.map((e, t) => this.renderPlayerSlot(a, e, t)),
      ),
      a.raceMode ? this.renderRaceRules() : l.default.createElement(
        'div',
        {
          className: 'game-options',
        },
        l.default.createElement(
          'div',
          {
            className: 'game-options-left',
          },
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:HostCBoxShortGame'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'shortGame',
                checked: a.shortGame,
                onChange: (e) => this.props.onToggleShortGame(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:ShortGame')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:HostCBoxRedeploys'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'mcvRepacks',
                checked: a.mcvRepacks,
                onChange: (e) => this.props.onToggleMcvRepacks(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:MCVRepacks')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:HostCBoxCrates'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'cratesAppear',
                checked: a.cratesAppear,
                onChange: (e) => this.props.onToggleCratesAppear(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:CratesAppear')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:HostCBoxSWAllowed'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'superWeapons',
                checked: a.superWeapons,
                onChange: (e) => this.props.onToggleSuperWeapons(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:SuperWeaponsAllowed')),
            ),
          ),
          void 0 !== a.hostTeams &&
            l.default.createElement(
              'div',
              {
                'data-r-tooltip': e.get('STT:HostCBoxHostTeams'),
              },
              l.default.createElement(
                'label',
                null,
                l.default.createElement('input', {
                  type: 'checkbox',
                  name: 'hostTeams',
                  checked: a.hostTeams,
                  onChange: (e) => this.props.onToggleHostTeams?.(e.target.checked),
                  disabled: !r,
                }),
                ' ',
                l.default.createElement('span', null, e.get('GUI:HostTeams')),
              ),
            ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:DestroyableBridges'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'destBridges',
                checked: a.destroyableBridges,
                onChange: (e) => this.props.onToggleDestroyableBridges?.(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:DestroyableBridges')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:MultiEngineer', a.multiEngineerCount),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'multiEngineer',
                checked: a.multiEngineer,
                onChange: (e) => this.props.onToggleMultiEngineer?.(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:MultiEngineer')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:InstantCapture'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'instantCapture',
                checked: a.instantCapture || a.multiEngineer,
                onChange: (e) => this.props.onToggleInstantCapture?.(e.target.checked),
                disabled: !r || a.multiEngineer,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:InstantCapture')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:NoDogEngiKills'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'noDogEngiKills',
                checked: a.noDogEngiKills,
                onChange: (e) => this.props.onToggleNoDogEngiKills?.(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:NoDogEngiKills')),
            ),
          ),
          l.default.createElement(
            'div',
            {
              'data-r-tooltip': e.get('STT:DelayedOils'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'delayedOils',
                checked: a.delayedOils,
                onChange: (e) => this.props.onToggleDelayedOils?.(e.target.checked),
                disabled: !r,
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:DelayedOils')),
            ),
          ),
        ),
        l.default.createElement(
          'div',
          {
            className: 'game-options-right' + (r ? '' : ' all-disabled'),
          },
          l.default.createElement(
            'div',
            {
              className: 'slider-item',
            },
            l.default.createElement(
              'span',
              {
                className: 'label',
              },
              e.get('GUI:GameSpeed'),
            ),
            l.default.createElement(o.Slider, {
              name: 'gameSpeed',
              min: 0,
              max: 6,
              value: '' + a.gameSpeed,
              disabled: !r,
              'data-r-tooltip': e.get('STT:HostSliderSpeed'),
              onChange: (e) => this.props.onChangeGameSpeed(Number(e.target.value)),
            }),
          ),
          l.default.createElement(
            'div',
            {
              className: 'slider-item',
            },
            l.default.createElement(
              'span',
              {
                className: 'label',
              },
              e.get('GUI:Credits'),
            ),
            l.default.createElement(o.Slider, {
              name: 'credits',
              min: i.minMoney,
              max: i.maxMoney,
              step: i.moneyIncrement,
              value: '' + a.credits,
              'data-r-tooltip': e.get('STT:HostSliderCredits'),
              onChange: (e) => this.props.onChangeCredits(Number(e.target.value)),
              disabled: !r,
            }),
          ),
          l.default.createElement(
            'div',
            {
              className: 'slider-item',
            },
            l.default.createElement(
              'span',
              {
                className: 'label',
              },
              e.get('GUI:UnitCount'),
            ),
            l.default.createElement(o.Slider, {
              name: 'unitCount',
              min: i.minUnitCount,
              max: i.maxUnitCount,
              value: '' + a.unitCount,
              'data-r-tooltip': e.get('STT:HostSliderUnit'),
              onChange: (e) => this.props.onChangeUnitCount(Number(e.target.value)),
              disabled: !r,
            }),
          ),
          l.default.createElement(
            'div',
            {
              className: 'checkbox-item',
              'data-r-tooltip': e.get('STT:HostCBoxBuildOffAlly'),
            },
            l.default.createElement(
              'label',
              null,
              l.default.createElement('input', {
                type: 'checkbox',
                name: 'buildOffAlly',
                checked: a.buildOffAlly,
                disabled: !r,
                onChange: (e) => this.props.onToggleBuildOffAlly(e.target.checked),
              }),
              ' ',
              l.default.createElement('span', null, e.get('GUI:BuildOffAlly')),
            ),
          ),
        ),
      ),
      void 0 !== this.props.messages &&
        void 0 !== this.props.localUsername &&
        this.props.onSendMessage &&
        l.default.createElement(h.Chat, {
          messages: this.props.messages,
          localUsername: this.props.localUsername,
          channels: this.props.channels ?? [],
          chatHistory: this.props.chatHistory,
          onSendMessage: this.props.onSendMessage,
          tooltips: {
            button: e.get('STT:EmoteButton'),
            input: r ? e.get('STT:HostEditInput') : e.get('STT:GuestEditInput'),
            output: r ? e.get('STT:HostEditOutput') : e.get('STT:GuestEditOutput'),
          },
          strings: e,
        }),
    );
  }
  renderPlayerSlot(e: LobbyModel.LobbyFormProps, t: LobbyModel.LobbyPlayerSlot | undefined, i: number): React.ReactNode {
    const r = e.strings;
    var s = e.lobbyType === c.LobbyType.Singleplayer || e.lobbyType === c.LobbyType.MultiplayerHost;
    return t
      ? l.default.createElement(
          'div',
          {
            className: 'player-slot',
            key: 'playerslot' + i,
          },
          t.type === c.SlotType.Player
            ? l.default.createElement(b.RankIndicator, {
                playerProfile: t.playerProfile,
                strings: r,
              })
            : l.default.createElement(b.RankIndicator, {
                playerProfile: void 0,
                strings: r,
              }),
          l.default.createElement(d.PingIndicator, {
            ping: t.type === c.SlotType.Player ? t.ping : void 0,
            strings: r,
          }),
          l.default.createElement(
            'div',
            {
              className: 'player-status',
              'data-r-tooltip': r.get('STT:HostPictureAcceptance'),
            },
            this.renderPlayerStatus(t.status),
          ),
          this.renderPlayerSelect(t, i, e.lobbyType),
          l.default.createElement(a.CountrySelect, {
            countryUiNames: e.countryUiNames,
            countryUiTooltips: e.countryUiTooltips,
            country: t.country,
            raceMode: e.raceMode,
            availableCountries: e.availablePlayerCountries,
            disabled:
              !!e.lockScenarioSlots ||
              (i !== e.activeSlotIndex && (!s || t.type !== c.SlotType.Ai)) ||
              t.type === c.SlotType.Observer ||
              (t.status === c.PlayerStatus.Ready && t.type !== c.SlotType.Ai),
            strings: e.strings,
            onSelect: (e) => this.props.onCountrySelect(e, i),
          }),
          t.type !== c.SlotType.Observer
            ? l.default.createElement(
                l.default.Fragment,
                null,
                l.default.createElement(u.ColorSelect, {
                  color: t.color,
                  availableColors: e.availablePlayerColors,
                  disabled:
                    !!e.lockScenarioSlots ||
                    (i !== e.activeSlotIndex && (!s || t.type !== c.SlotType.Ai)) ||
                    (t.status === c.PlayerStatus.Ready && t.type !== c.SlotType.Ai),
                  strings: e.strings,
                  onSelect: (e) => this.props.onColorSelect(e, i),
                }),
                l.default.createElement(p.StartPosSelect, {
                  disabled: e.lockScenarioSlots
                    ? true
                    : e.hostTeams
                    ? !s || t.occupation !== c.SlotOccupation.Occupied
                    : (i !== e.activeSlotIndex && (!s || t.type !== c.SlotType.Ai)) ||
                      (t.status === c.PlayerStatus.Ready && t.type !== c.SlotType.Ai),
                  startPos: t.startPos,
                  availableStartPositions: e.availableStartPositions,
                  onSelect: (e) => this.props.onStartPosSelect(e, i),
                  strings: e.strings,
                }),
                l.default.createElement(m.TeamSelect, {
                  disabled:
                    !!e.lockScenarioSlots ||
                    !e.teamsAllowed ||
                    (e.hostTeams
                      ? !s || t.occupation !== c.SlotOccupation.Occupied
                      : (i !== e.activeSlotIndex && (!s || t.type !== c.SlotType.Ai)) ||
                        (t.status === c.PlayerStatus.Ready && t.type !== c.SlotType.Ai)),
                  teamId: e.teamsAllowed ? t.team : f.NO_TEAM_ID,
                  required: e.teamsRequired,
                  maxTeams: e.maxTeams,
                  onSelect: (e) => this.props.onTeamSelect(e, i),
                  strings: e.strings,
                }),
              )
            : null,
        )
      : l.default.createElement('div', {
          className: 'player-slot',
          key: 'playerslot' + i,
        });
  }
  renderPlayerStatus(e: LobbyModel.PlayerStatus | undefined): React.ReactNode {
    return e === c.PlayerStatus.Host
      ? l.default.createElement(i.Image, {
          src: 'wolhost.pcx',
        })
      : e === c.PlayerStatus.Ready
        ? l.default.createElement(i.Image, {
            src: 'wolacpt.pcx',
          })
        : null;
  }
  renderPlayerSelect(i: LobbyModel.LobbyPlayerSlot, t: number, e: LobbyModel.LobbyType): React.ReactNode {
    let r = e === c.LobbyType.Singleplayer;
    var s = r || e === c.LobbyType.MultiplayerHost;
    if (t === this.props.activeSlotIndex || (s && 0 === t))
      return l.default.createElement('input', {
        type: 'text',
        className: 'player-name',
        value: formatDisplayNickname(i.name),
        readOnly: !0,
      });
    let a = this.props.strings,
      n = new Map<LobbyModel.SlotOccupation | string, string>()
        .set(c.SlotOccupation.Occupied, formatDisplayNickname(i.name) || '')
        .set(c.SlotOccupation.Open, a.get(i.type === c.SlotType.Observer ? 'GUI:OpenObserver' : 'GUI:Open'))
        .set(c.SlotOccupation.Closed, r ? a.get('GUI:None') : a.get('GUI:Closed')),
      o: number | string | undefined = i.occupation;
    return (
      i.occupation === c.SlotOccupation.Occupied &&
        i.type === c.SlotType.Ai &&
        (n.delete(c.SlotOccupation.Occupied), (o = g.AiDifficulty[i.aiDifficulty!])),
      i.type !== c.SlotType.Observer &&
        this.props.availableAiNames.forEach((e, t) => {
          n.set(g.AiDifficulty[t] as string, a.get(e));
        }),
      l.default.createElement(
        y.Select<string>,
        {
          initialValue: '' + o,
          disabled: !s || !!this.props.lockScenarioSlots,
          onSelect: (e) => this.onPlayerSelect(e, t),
          className: 'player-name',
          tooltip: r ? a.get('STT:SkirmishComboAiPlayer') : a.get('STT:HostComboPlayer'),
        },
        [...n]
          .map(([t, e]) =>
            (t === c.SlotOccupation.Occupied && i.occupation !== c.SlotOccupation.Occupied) ||
            (t === c.SlotOccupation.Open && r)
              ? null
              : l.default.createElement(T.Option, {
                  key: t,
                  value: '' + t,
                  label: e,
                  tooltip: r
                    ? (() => {
                        let e;
                        return (
                          (e =
                            t === c.SlotOccupation.Closed
                              ? 'STT:PlayerNone'
                              : f.aiUiTooltips.get(
                                  typeof t === 'number' ? (g.AiDifficulty[t] as string) : String(t),
                                )),
                          e ? a.get(e) : void 0
                        );
                      })()
                    : void 0,
                }),
          )
          .filter(v.isNotNullOrUndefined),
      )
    );
  }
}
export { r as LobbyForm };
