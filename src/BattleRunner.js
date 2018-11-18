'use strict;'

const _ = require('lodash'),
      is_dev = require('electron-is-dev');

const Rat = require(__dirname + '/Rat.js'),
      Ship = require(__dirname + '/Ship.js');

// 索敵結果の表示などにかかる時間
const PERFORMANCE_OPENING = 12;
const PERFORMANCE_OPENING_KOUKU = 8;
const PERFORMANCE_HOUGEKI_ACTION = 1.1;
const PERFORMANCE_HOUGEKI_PREPARE = 0.6;
const PERFORMANCE_FRIEND_DAMAGED = 4.6;
const PERFORMANCE_ENDING = 3.3;

class Damage {
  constructor(type, attacker, defender) {
    this.type = type;
    this.attacker = attacker;
    this.defender = defender;
  }

  toString() {
    switch (this.type) {
      case 6:
        return '弾着観測射撃';
      case 2:
        return '連撃';
      case 0:
        return '通常攻撃';
      case 7:
        return '空母カットイン攻撃';
      default:
        return '(不明' + this.type + ')';
    }
  }

  performance_seconds() {
    switch (this.type) {
      case 6:
      case 7:
        return 177.0 / 29.167;
      case 2:
        return 83.0 / 29.167;
      case 0:
        const defender_stype = this.defender.type().value();
        const attacker_stype = this.attacker.type().value();
        if ([7, 11, 18].indexOf(attacker_stype) >= 0) {
          // 空母による通常攻撃
          return 110.0 / 29.167;
        } else if ([13, 14].indexOf(defender_stype) >= 0) {
          if ([1, 2, 3, 4, 21].indexOf(attacker_stype) >= 0) {
            // 駆逐軽巡海防艦による対潜攻撃
            // 81f@29.167fps
            return 81.0 / 29.167;
          } else {
            // 水上爆撃機による対潜攻撃
            return 110.0 / 29.167;
          }
        } else {
          // 砲撃
          return 51.0 / 29.167;
        }
      default:
        return 0.0;
    }
  }
}

class BattleRunner {
  constructor(storage) {
    this._storage = storage;
    this._enemies = [];
    this._midnight = false;
    this._performance_seconds = 0;
    this._friends_hp = [];
    this._friends = [];
  }

  append(api, data) {
    this._performance_seconds = 0;

    switch (api) {
      case 'api_req_sortie/battle':
        this.battle(data);
        break;
    }
  }

  // api_req_sortie/battle
  battle(api_data) {
    this.add_performance_seconds("開幕", PERFORMANCE_OPENING);
    this._battle(api_data);
    this.add_performance_seconds("終了", PERFORMANCE_ENDING);
  }

  midnight_battle(api_data) {
    this._battle(api_data);
  }

  _battle(api_data) {
    if (this._enemies.length == 0) {
      // 敵艦の HP 初期値を取得
      const nowhps = _.get(api_data, ["api_data", "api_e_nowhps"], []);
      const maxhps = _.get(api_data, ["api_data", "api_e_maxhps"], []);
      const enemy_ship_ids = _.get(api_data, ['api_data', 'api_ship_ke'], []);
      if (nowhps.length == maxhps.length && nowhps.length == enemy_ship_ids.length) {
        for (var i = 0; i < nowhps.length; i++) {
          const ship_id = enemy_ship_ids[i];
          const nowhp = nowhps[i];
          const maxhp = maxhps[i];
          const data = {
            api_nowhp: nowhp,
            api_maxhp: maxhp,
          };
          const master = this._storage.master.ship(ship_id);
          const enemy = new Ship(data, master, this.storage);
          this._enemies.push(enemy);
        }
      }
    }
    if (this._friends_hp.length == 0) {
      const deck_id = _.get(api_data, ['api_data', 'api_deck_id'], 0);
      const deck_index = deck_id - 1;
      const nowhps = _.get(api_data, ['api_data', 'api_f_nowhps'], []);
      const maxhps = _.get(api_data, ['api_data', 'api_f_maxhps'], []);
      if (nowhps.length == maxhps.length && 0 <= deck_index && deck_index < this._storage.port.decks.length) {
        const deck = this._storage.port.decks[deck_index];
        for (var i = 0; i < nowhps.length; i++) {
          const nowhp = nowhps[i];
          const maxhp = maxhps[i];
          this._friends_hp.push(new Rat(nowhp, maxhp));
          this._friends.push(deck.ships[i]);
        }
      }
    }

    // 夜戦の必要があるかどうか
    this._midnight = _.get(api_data, ['api_data', 'api_midnight_flag'], 0) != 0;

    // 開幕航空戦
    const air_fire = _.get(api_data, ['api_data', 'api_kouku', 'api_stage2', 'api_air_fire'], null);
    if (air_fire != null) {
      // 対空カットインが発生している
      this.add_performance_seconds('対空カットイン', 86 / 29.167);
    }
    const kouku_stage3 = _.get(api_data, ["api_data", "api_kouku", "api_stage3"], null);
    if (kouku_stage3 != null) {
      this.add_performance_seconds("開幕航空戦", PERFORMANCE_OPENING_KOUKU);

      const fdam = _.get(kouku_stage3, ['api_fdam'], []);
      const edam = _.get(kouku_stage3, ['api_edam'], []);

      this._fdam_list(fdam);
      this._edam_list(edam);
    }

    // 開幕対潜
    if (_.get(api_data, ['api_data', 'api_opening_taisen_flag'], 0) != 0) {
      const attack = _.get(api_data, ['api_data', 'api_opening_taisen'], null);
      if (attack != null) {
        this._step(attack);
      }
    }

    // 開幕雷撃
    const opening_attack = _.get(api_data, ["api_data", "api_opening_atack"], null);
    if (opening_attack != null) {
      this.add_performance_seconds("開幕雷撃", 105 / 29.167);

      const fdam = _.get(opening_attack, ['api_fdam'], []);
      const edam = _.get(opening_attack, ['api_edam'], []);
      this._fdam_list(fdam);
      this._edam_list(edam);
    }

    // 砲雷戦

    const hourai_flag = _.get(api_data, ["api_data", "api_hourai_flag"], []);
    for (var i = 0; i < 3; i++) {
      const flag = hourai_flag[i];
      if (flag != 1) {
        continue;
      }
      const key = 'api_hougeki' + (i + 1);
      const attack = _.get(api_data, ["api_data", key], []);
      this._step(attack);
    }

    const raigeki = _.get(api_data, ['api_data', 'api_raigeki'], null);
    if (raigeki != null) {
      this.add_performance_seconds('雷撃戦', 105 / 29.167);

      const fdam = _.get(raigeki, ['api_fdam'], []);
      const edam = _.get(raigeki, ['api_edam'], []);

      this._fdam_list(fdam);
      this._edam_list(edam);
    }
  }

  _step(attack) {
    const at_eflag = _.get(attack, ["api_at_eflag"], []);
    const at_type = _.get(attack, ['api_at_type'], []);
    const df_list = _.get(attack, ["api_df_list"], []);
    const damage = _.get(attack, ["api_damage"], []);
    const at_list = _.get(attack, ['api_at_list'], []);
    const count = at_eflag.length;
    if (df_list.length != count || damage.length != count) {
      return;
    }
    for (var j = 0; j < count; j++) {
      const index_list = df_list[j];
      const damage_list = damage[j];
      if (index_list.length != damage_list.length) {
        continue;
      }
      const type = at_type[j];

      const attacker_index = at_list[j];
      let attacker = null;
      let attacker_description = '';
      let defender_description = '';

      // at_eflag[j] = 0 なら自軍、1なら敵軍の攻撃
      const attacker_is_enemy = at_eflag[j] == 1;
      if (attacker_is_enemy) {
        attacker = this._enemies[attacker_index];
        attacker_description = '敵軍';
        defender_description = '自軍';
      } else {
        attacker = this._friends[attacker_index];
        attacker_description = '自軍';
        defender_description = '敵軍';
      }

      for (var k = 0; k < index_list.length; k++) {
        const defender_index = index_list[k];
        const dam = damage_list[k];

        let defender = null;

        if (attacker_is_enemy) {
          defender = this._friends[defender_index];
        } else {
          defender = this._enemies[defender_index];
        }

        const damage = new Damage(type, attacker, defender);
        const seconds = k == 0 ? damage.performance_seconds() : 0;
        this.add_performance_seconds(attacker_description + (attacker_index + 1) + '番艦が' + defender_description + (defender_index + 1) + "番艦に" + damage + "による" + dam + "のダメージ", seconds);

        if (attacker_is_enemy) {
          const additional = this._fdam(defender_index, dam);
          if (additional > 0) {
            this.add_performance_seconds(defender_description + (defender_index + 1) + "番艦が大ダメージを受けた", additional);
          }
        } else {
          this._edam(defender_index, dam);
        }
      }
    }
  }

  _fdam_list(fdam) {
    let max_seconds = 0;
    let damaged_f_ships = [];
    for (let i = 0; i < fdam.length; i++) {
      let seconds = this._fdam(i, fdam[i]);
      if (seconds > 0) {
        damaged_f_ships.push(i + i);
        max_seconds = Math.max(max_seconds, seconds);
      }
    }
    if (max_seconds > 0) {
      this.add_performance_seconds(damaged_f_ships.join(', ') + '番艦が大ダメージを受けた', max_seconds);
    }
  }

  _edam_list(edam) {
    for (var i = 0; i < edam.length; i++) {
      this._edam(i, edam[i]);
    }
  }

  _fdam(index, amount) {
    if (typeof(amount) != 'number') {
      return 0;
    }
    if (amount <= 0) {
      return 0;
    }
    if (index < 0 || this._friends_hp.length <= index) {
      return 0;
    }
    const current = this._friends_hp[index];
    const nowhp = Math.max(0, current.numerator() - Math.floor(amount));
    const next = new Rat(nowhp, current.denominator());
    if (current.value() > 0.5 && next.value() <= 0.5) {
      // 通常から中破大破になった
      return PERFORMANCE_FRIEND_DAMAGED;
    } else {
      return 0;
    }
  }

  _edam(index, amount) {
    if (typeof(amount) != 'number') {
      return 0;
    }
    if (amount <= 0) {
      return 0;
    }
    if (index < 0 || this._enemies.length <= index) {
      return 0;
    }
    const enemy = this._enemies[index];
    const current_hp = enemy.hp();
    const next = Math.max(0, current_hp.numerator() - Math.floor(amount));
    enemy.set_hp(new Rat(next, current_hp.denominator()));

    return PERFORMANCE_HOUGEKI_ACTION;
  }

  // api_req_sortie/ld_airbattle
  ld_airbattle(api_data) {

  }

  // api_req_combined_battle/ec_battle
  ec_battle(api_data) {

  }

  // api_req_combined_battle/ec_midnight_battle
  ec_midnight_battle(api_data) {

  }

  // 敵艦のリストを返す。[Ship]
  enemies() {
    return this._enemies;
  }

  is_midnight_planned() {
    return this._midnight;
  }

  // 戦闘の演出にかかる時間
  performance_seconds() {
    return this._performance_seconds;
  }

  add_performance_seconds(message, delta_seconds) {
    const before = this._performance_seconds;
    this._performance_seconds += delta_seconds;
    if (is_dev) {
      console.log(message + "\t" + before + "\t" + this._performance_seconds);
    }
  }
}

module.exports = BattleRunner;
