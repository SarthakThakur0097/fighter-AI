import math
import numpy as np
import pandas as pd
from datetime import datetime

# ── Constants ─────────────────────────────────────────────────────────────────
LAM    = math.log(2) / (1.5 * 365)  # 1.5yr half-life decay
WINDOW = 5
K_MEAN = 4.0
K_MAD  = 4.0

# ── Parsing Helpers ───────────────────────────────────────────────────────────

def parse_reach(r):
    if pd.isna(r) or r == '--': return None
    try: return float(r.replace('"', ''))
    except: return None

def parse_height(h):
    if pd.isna(h) or h == '--': return None
    try:
        parts = h.replace('"', '').split("'")
        return int(parts[0]) * 12 + int(parts[1])
    except: return None

def parse_age(dob, fight_date):
    if pd.isna(dob) or pd.isna(fight_date): return None
    try:
        birth = datetime.strptime(dob, "%b %d, %Y")
        fight = datetime.strptime(fight_date, "%Y-%m-%d")
        return (fight - birth).days / 365.25
    except: return None

def parse_fight_duration(ending_round, ending_time):
    try:
        mins, secs = ending_time.split(':')
        final_round_minutes = int(mins) + int(secs) / 60
        return ((ending_round - 1) * 5) + final_round_minutes
    except: return 15.0

def normalize_weight_class(wc):
    if pd.isna(wc): return None
    wc = wc.strip()
    mens_classes = [
        'Heavyweight', 'Light Heavyweight', 'Middleweight',
        'Welterweight', 'Lightweight', 'Featherweight',
        'Bantamweight', 'Flyweight', 'Catch Weight'
    ]
    for base in mens_classes:
        if base in wc and "Women's" not in wc:
            return f'{base} Bout'
    womens_classes = [
        "Women's Atomweight", "Women's Bantamweight",
        "Women's Featherweight", "Women's Flyweight",
        "Women's Strawweight"
    ]
    for base in womens_classes:
        if wc == f"{base} Bout":
            return f"{base} Bout"
    return None

# ── Statistical Helpers ───────────────────────────────────────────────────────

def time_decay_weights(dates, as_of_date, lam=LAM):
    as_of = datetime.strptime(as_of_date, "%Y-%m-%d")
    weights = []
    for d in dates:
        fight_dt = datetime.strptime(d, "%Y-%m-%d")
        days_ago = (as_of - fight_dt).days
        w = np.exp(-lam * max(days_ago, 0))
        weights.append(w)
    weights = np.array(weights)
    return weights / weights.sum() if weights.sum() > 0 else weights

def kish_effective_n(weights):
    if weights.sum() == 0: return 0
    return (weights.sum() ** 2) / (weights ** 2).sum()

def bayesian_smooth(observed, n_eff, population_mean, k):
    w = n_eff / (n_eff + k)
    return w * observed + (1 - w) * population_mean

# ── Feature Functions ─────────────────────────────────────────────────────────

def calculate_three_layer_features_v2(fighter_id, opponent_id, as_of_date,
                                       fighter_fights_dict, opponents_dict,
                                       fighter_adjperf_history, all_fight_stats,
                                       stats=None, window=WINDOW):
    if stats is None:
        stats = ['slpm', 'str_acc', 'td_acc', 'td_avg', 'sub_avg',
                 'ctrl_time_per_min', 'kd_per_min']

    if fighter_id not in fighter_fights_dict or opponent_id not in fighter_fights_dict:
        return None

    fighter_hist  = fighter_fights_dict[fighter_id]
    opponent_hist = fighter_fights_dict[opponent_id]
    fighter_prev  = fighter_hist[fighter_hist['event_date'] < as_of_date]
    opponent_prev = opponent_hist[opponent_hist['event_date'] < as_of_date]

    if len(fighter_prev) == 0 or len(opponent_prev) == 0:
        return None

    pop_means = {s: float(np.median(all_fight_stats[s].values)) for s in stats}
    pop_mads  = {s: float(np.median(np.abs(
        all_fight_stats[s].values - pop_means[s]
    ))) for s in stats}

    fighter_recent  = fighter_prev.tail(window)
    fighter_weights = time_decay_weights(fighter_recent['event_date'].tolist(), as_of_date)
    fighter_n_eff   = kish_effective_n(fighter_weights)

    features = {}

    for stat in stats:
        decayed_avg   = np.average(fighter_recent[stat].values, weights=fighter_weights)
        smoothed_stat = bayesian_smooth(decayed_avg, fighter_n_eff, pop_means[stat], K_MEAN)
        features[f'{stat}_dec_avg'] = smoothed_stat

        opp_allowed, opp_dates = [], []
        for _, opp_fight in opponent_prev.iterrows():
            opp_opp_id = opponents_dict.get((opp_fight['fight_id'], opponent_id))
            if opp_opp_id and opp_opp_id in fighter_fights_dict:
                opp_opp_fights     = fighter_fights_dict[opp_opp_id]
                opp_opp_this_fight = opp_opp_fights[
                    opp_opp_fights['fight_id'] == opp_fight['fight_id']
                ]
                if len(opp_opp_this_fight) > 0:
                    opp_allowed.append(opp_opp_this_fight[stat].iloc[0])
                    opp_dates.append(opp_fight['event_date'])

        if len(opp_allowed) >= 2:
            opp_weights = time_decay_weights(opp_dates, as_of_date)
            opp_n_eff   = kish_effective_n(opp_weights)
            opp_mean    = np.average(opp_allowed, weights=opp_weights)
            opp_mad     = float(np.median(np.abs(np.array(opp_allowed) - np.median(opp_allowed))))
            opp_mu      = bayesian_smooth(opp_mean, opp_n_eff, pop_means[stat], K_MEAN)
            opp_sigma   = max(bayesian_smooth(opp_mad, opp_n_eff, pop_mads[stat], K_MAD), 0.01)
            features[f'{stat}_opp_dec_avg'] = opp_mu
            features[f'{stat}_opp_mad']     = opp_sigma
            features[f'{stat}_adjperf']     = np.clip((smoothed_stat - opp_mu) / opp_sigma, -7, 7)
        else:
            features[f'{stat}_opp_dec_avg'] = pop_means[stat]
            features[f'{stat}_opp_mad']     = 1.0
            features[f'{stat}_adjperf']     = 0.0

        if fighter_id in fighter_adjperf_history:
            ap_hist  = fighter_adjperf_history[fighter_id]
            ap_prev  = ap_hist[ap_hist['event_date'] < as_of_date].tail(window)
            snap_col = f'{stat}_adjperf_snapshot'
            if len(ap_prev) > 0 and snap_col in ap_prev.columns:
                ap_weights = time_decay_weights(ap_prev['event_date'].tolist(), as_of_date)
                ap_n_eff   = kish_effective_n(ap_weights)
                ap_dec_avg = np.average(ap_prev[snap_col].values, weights=ap_weights)
                features[f'{stat}_dec_adjperf'] = bayesian_smooth(ap_dec_avg, ap_n_eff, 0.0, K_MEAN)
            else:
                features[f'{stat}_dec_adjperf'] = 0.0
        else:
            features[f'{stat}_dec_adjperf'] = 0.0

    return features


def calculate_strike_features(fighter_id, opponent_id, as_of_date,
                               strike_breakdown_dict, strike_defense_dict,
                               fighter_adjperf_history, opponents_dict,
                               window=WINDOW):
    STRIKE_STATS_OFF      = ['head_lpm', 'body_lpm', 'leg_lpm',
                              'distance_lpm', 'clinch_lpm', 'ground_lpm',
                              'head_acc', 'body_acc', 'distance_acc']
    STRIKE_STATS_DEF      = ['head_allowed', 'body_allowed', 'leg_allowed',
                              'distance_allowed', 'clinch_allowed', 'ground_allowed']
    STRIKE_ADJPERF_CACHED = ['head_lpm', 'body_acc', 'distance_acc',
                              'distance_lpm', 'ground_allowed',
                              'head_acc', 'distance_allowed']

    features = {}

    off_priors = {}
    for s in STRIKE_STATS_OFF:
        if s in strike_breakdown_dict.get('_meta_df', pd.DataFrame()).columns:
            median = float(strike_breakdown_dict['_meta_df'][s].median())
            mad    = float(max(np.median(np.abs(strike_breakdown_dict['_meta_df'][s].values - median)), 0.01))
            off_priors[s] = {'mean': median, 'mad': mad}
        else:
            off_priors[s] = {'mean': 0.0, 'mad': 1.0}

    fighter_off_smoothed = {}
    if fighter_id in strike_breakdown_dict:
        hist = strike_breakdown_dict[fighter_id]
        prev = hist[hist['event_date'] < as_of_date].tail(window)
        if len(prev) > 0:
            weights = time_decay_weights(prev['event_date'].tolist(), as_of_date)
            n_eff   = kish_effective_n(weights)
            for s in STRIKE_STATS_OFF:
                if s not in prev.columns:
                    features[f'{s}_dec_avg'] = off_priors[s]['mean']
                    fighter_off_smoothed[s]  = off_priors[s]['mean']
                    continue
                dec_avg  = np.average(prev[s].values, weights=weights)
                smoothed = bayesian_smooth(dec_avg, n_eff, off_priors[s]['mean'], K_MEAN)
                features[f'{s}_dec_avg'] = smoothed
                fighter_off_smoothed[s]  = smoothed
        else:
            for s in STRIKE_STATS_OFF:
                features[f'{s}_dec_avg'] = off_priors[s]['mean']
                fighter_off_smoothed[s]  = off_priors[s]['mean']
    else:
        for s in STRIKE_STATS_OFF:
            features[f'{s}_dec_avg'] = off_priors[s]['mean']
            fighter_off_smoothed[s]  = off_priors[s]['mean']

    fighter_def_smoothed = {}
    if fighter_id in strike_defense_dict:
        hist = strike_defense_dict[fighter_id]
        prev = hist[hist['event_date'] < as_of_date].tail(window)
        if len(prev) > 0:
            weights = time_decay_weights(prev['event_date'].tolist(), as_of_date)
            n_eff   = kish_effective_n(weights)
            for s in STRIKE_STATS_DEF:
                dec_avg  = np.average(prev[s].values, weights=weights)
                smoothed = bayesian_smooth(dec_avg, n_eff, 0.0, K_MEAN)
                features[f'{s}_dec_avg'] = smoothed
                fighter_def_smoothed[s]  = smoothed
        else:
            for s in STRIKE_STATS_DEF:
                features[f'{s}_dec_avg'] = 0.0
                fighter_def_smoothed[s]  = 0.0
    else:
        for s in STRIKE_STATS_DEF:
            features[f'{s}_dec_avg'] = 0.0
            fighter_def_smoothed[s]  = 0.0

    for s in STRIKE_ADJPERF_CACHED:
        snap_col = f'{s}_adjperf_snapshot'
        if fighter_id in fighter_adjperf_history:
            ap_hist = fighter_adjperf_history[fighter_id]
            ap_prev = ap_hist[ap_hist['event_date'] < as_of_date].tail(window)
            if len(ap_prev) > 0 and snap_col in ap_prev.columns:
                ap_weights = time_decay_weights(ap_prev['event_date'].tolist(), as_of_date)
                ap_n_eff   = kish_effective_n(ap_weights)
                ap_dec_avg = np.average(ap_prev[snap_col].values, weights=ap_weights)
                features[f'{s}_dec_adjperf'] = bayesian_smooth(ap_dec_avg, ap_n_eff, 0.0, K_MEAN)
            else:
                features[f'{s}_dec_adjperf'] = 0.0
        else:
            features[f'{s}_dec_adjperf'] = 0.0

    return features


def calculate_career_stats(fighter_id, opponent_id, fight_id, as_of_date,
                            fighter_fights_dict, opponents_dict,
                            fighter_results_dict, fight_decision_dict,
                            all_fight_stats, window=10):
    TAU_WIN      = 25.0
    TAU_KO       = 23.0
    TAU_DEC      = 20.0
    TAU_SUB_LAND = 9.0

    defaults = {
        'days_since_last_fight': 180,
        'win_ratio':             0.5,
        'win_adjperf':           0.0,
        'ko_rate':               0.0,
        'ko_opp_dec_avg':        0.0,
        'decision_rate':         0.5,
        'sub_landing_rate':      0.0,
        'td_defense':            0.5,
        'td_land_ratio_opp':     0.0,
        'ctrl_ratio_opp':        0.0,
        'sub_att_allowed_pm':    0.0,
        'kd_allowed_pm':         0.0,
    }

    if fighter_id not in fighter_fights_dict:
        return defaults

    hist = fighter_fights_dict[fighter_id]
    prev = hist[hist['event_date'] < as_of_date]
    if len(prev) == 0:
        return defaults

    features = {}
    last_date = prev.iloc[-1]['event_date']
    features['days_since_last_fight'] = (
        datetime.strptime(as_of_date, "%Y-%m-%d") -
        datetime.strptime(last_date, "%Y-%m-%d")
    ).days

    fight_wc = None
    wc_row = all_fight_stats[all_fight_stats['fight_id'] == fight_id]
    if len(wc_row) > 0:
        fight_wc = wc_row.iloc[0]['weight_class']

    prior_fids = prev['fight_id'].tolist()
    results    = [r for r in [fighter_results_dict.get((fighter_id, fid)) for fid in prior_fids] if r]

    n_fights = len(results)
    if n_fights > 0:
        n_wins = sum(1 for r in results if r in ('win', 'ko_win'))
        n_kos  = sum(1 for r in results if r == 'ko_win')
        n_decs = sum(fight_decision_dict.get((fighter_id, fid), 0) for fid in prior_fids)
        features['win_ratio']     = (0.5 * TAU_WIN + n_wins) / (TAU_WIN + n_fights)
        features['ko_rate']       = (0.0 * TAU_KO  + n_kos)  / (TAU_KO  + n_fights)
        features['decision_rate'] = (0.5 * TAU_DEC  + n_decs) / (TAU_DEC  + n_fights)
    else:
        features['win_ratio']     = 0.5
        features['ko_rate']       = 0.0
        features['decision_rate'] = 0.5

    features['win_adjperf']      = 0.0
    features['sub_landing_rate'] = 0.05
    features['td_defense']       = 0.5
    features['sub_att_allowed_pm'] = 0.0
    features['kd_allowed_pm']    = 0.0
    features['ctrl_ratio_opp']   = 0.0
    features['ko_opp_dec_avg']   = 0.0
    features['td_land_ratio_opp'] = 0.0

    return features


def calculate_r1_features(fighter_id, opponent_id, as_of_date,
                           r1_stats_dict, opponents_dict,
                           fighter_adjperf_history,
                           strike_breakdown_dict,
                           window=WINDOW):
    R1_STATS = ['r1_slpm', 'r1_ctrl_per_min', 'r1_td_acc',
                'r1_kd_per_min', 'r1_rev_per_min', 'r1_td_att_per_min',
                'r1_head_lpm', 'r1_body_lpm', 'r1_leg_lpm', 'r1_clinch_lpm']

    features = {}

    r1_priors = {s: {'mean': 0.0, 'mad': 1.0} for s in R1_STATS}

    fighter_smoothed = {}
    if fighter_id in r1_stats_dict:
        hist = r1_stats_dict[fighter_id]
        prev = hist[hist['event_date'] < as_of_date].tail(window)
        if len(prev) > 0:
            weights = time_decay_weights(prev['event_date'].tolist(), as_of_date)
            n_eff   = kish_effective_n(weights)
            for s in R1_STATS:
                if s not in prev.columns:
                    features[f'{s}_dec_avg'] = r1_priors[s]['mean']
                    fighter_smoothed[s]      = r1_priors[s]['mean']
                    continue
                dec_avg  = np.average(prev[s].values, weights=weights)
                smoothed = bayesian_smooth(dec_avg, n_eff, r1_priors[s]['mean'], K_MEAN)
                features[f'{s}_dec_avg'] = smoothed
                fighter_smoothed[s]      = smoothed
        else:
            for s in R1_STATS:
                features[f'{s}_dec_avg'] = r1_priors[s]['mean']
                fighter_smoothed[s]      = r1_priors[s]['mean']
    else:
        for s in R1_STATS:
            features[f'{s}_dec_avg'] = r1_priors[s]['mean']
            fighter_smoothed[s]      = r1_priors[s]['mean']

    for s in R1_STATS:
        features[f'{s}_adjperf']     = 0.0
        features[f'{s}_opp_dec_avg'] = r1_priors[s]['mean']

    features['leg_land_r1_opp_dec_avg'] = 0.0

    for s in ['r1_slpm', 'r1_rev_per_min']:
        snap_col = f'{s}_adjperf_snapshot'
        if fighter_id in fighter_adjperf_history:
            ap_hist = fighter_adjperf_history[fighter_id]
            ap_prev = ap_hist[ap_hist['event_date'] < as_of_date].tail(window)
            if len(ap_prev) > 0 and snap_col in ap_prev.columns:
                ap_weights = time_decay_weights(ap_prev['event_date'].tolist(), as_of_date)
                ap_n_eff   = kish_effective_n(ap_weights)
                ap_dec_avg = np.average(ap_prev[snap_col].values, weights=ap_weights)
                features[f'{s}_dec_adjperf'] = bayesian_smooth(ap_dec_avg, ap_n_eff, 0.0, K_MEAN)
            else:
                features[f'{s}_dec_adjperf'] = 0.0
        else:
            features[f'{s}_dec_adjperf'] = 0.0

    return features