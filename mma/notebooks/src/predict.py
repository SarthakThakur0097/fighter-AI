import pickle
import sqlite3
import pandas as pd
import numpy as np
from datetime import datetime
from src.features import (
    calculate_three_layer_features_v2,
    calculate_strike_features,
    calculate_r1_features,
    calculate_career_stats,
    parse_reach,
    parse_height,
    parse_age,
    time_decay_weights,
    kish_effective_n,
    bayesian_smooth,
    normalize_weight_class,
)

# ── Config ────────────────────────────────────────────────────────────────────
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATA_PATH = os.path.abspath(os.path.join(BASE_DIR, "../02_features/data"))

DB_PATH = os.path.abspath(os.path.join(BASE_DIR, "../../../mma_fighters.db"))

print(f"[predict] DB_PATH: {DB_PATH}")
print(f"[predict] DB exists: {os.path.exists(DB_PATH)}")
# ── Load everything once at module level ─────────────────────────────────────
print("[predict] Loading model and cached data...")

model = pickle.load(open(f"{DATA_PATH}/xgb_best_model.pkl", "rb"))
feature_cols = pickle.load(open(f"{DATA_PATH}/feature_cols.pkl", "rb"))
fighter_fights_dict = pickle.load(open(f"{DATA_PATH}/fighter_fights_dict.pkl", "rb"))
opponents_dict = pickle.load(open(f"{DATA_PATH}/opponents_dict.pkl", "rb"))
fighter_adjperf_history = pickle.load(
    open(f"{DATA_PATH}/fighter_adjperf_history.pkl", "rb")
)
all_fight_stats = pickle.load(open(f"{DATA_PATH}/all_fight_stats.pkl", "rb"))
strike_breakdown_dict = pickle.load(
    open(f"{DATA_PATH}/strike_breakdown_dict.pkl", "rb")
)
strike_defense_dict = pickle.load(open(f"{DATA_PATH}/strike_defense_dict.pkl", "rb"))
r1_stats_dict = pickle.load(open(f"{DATA_PATH}/r1_stats_dict.pkl", "rb"))
fighter_results_dict = pickle.load(open(f"{DATA_PATH}/fighter_results_dict.pkl", "rb"))
fight_decision_dict = pickle.load(open(f"{DATA_PATH}/fight_decision_dict.pkl", "rb"))
method_model = pickle.load(open(f"{DATA_PATH}/method_model.pkl", "rb"))
method_feature_cols = pickle.load(open(f"{DATA_PATH}/method_feature_cols.pkl", "rb"))
method_le = pickle.load(open(f"{DATA_PATH}/method_label_encoder.pkl", "rb"))

print(f"[predict] Ready. {len(fighter_fights_dict)} fighters loaded.")

# ── Helpers ───────────────────────────────────────────────────────────────────


def _find_fighter(name, all_fighters):
    exact = all_fighters[all_fighters["name"].str.lower() == name.lower()]
    if len(exact) == 1:
        return exact.iloc[0]
    full = all_fighters[all_fighters["name"].str.contains(name, case=False, na=False)]
    if len(full) == 1:
        return full.iloc[0]
    if len(full) > 1:
        return full.iloc[0]
    last = name.split()[-1]
    partial = all_fighters[
        all_fighters["name"].str.contains(last, case=False, na=False)
    ]
    if len(partial) > 0:
        return partial.iloc[0]
    return None


def _get_ufc_age(fid, as_of_date):
    if fid in fighter_fights_dict:
        first = fighter_fights_dict[fid].iloc[0]["event_date"]
        return (
            datetime.strptime(as_of_date, "%Y-%m-%d")
            - datetime.strptime(first, "%Y-%m-%d")
        ).days / 365.25
    return 0


def _build_feature_row(f1_id, f2_id, as_of_date, conn):
    """Build the shared feature row used by both win and method models."""
    f1_feats = calculate_three_layer_features_v2(
        f1_id,
        f2_id,
        as_of_date,
        fighter_fights_dict=fighter_fights_dict,
        opponents_dict=opponents_dict,
        fighter_adjperf_history=fighter_adjperf_history,
        all_fight_stats=all_fight_stats,
    )
    f2_feats = calculate_three_layer_features_v2(
        f2_id,
        f1_id,
        as_of_date,
        fighter_fights_dict=fighter_fights_dict,
        opponents_dict=opponents_dict,
        fighter_adjperf_history=fighter_adjperf_history,
        all_fight_stats=all_fight_stats,
    )
    if f1_feats is None or f2_feats is None:
        return None

    f1_feats.update(
        calculate_strike_features(
            f1_id,
            f2_id,
            as_of_date,
            strike_breakdown_dict=strike_breakdown_dict,
            strike_defense_dict=strike_defense_dict,
            fighter_adjperf_history=fighter_adjperf_history,
            opponents_dict=opponents_dict,
        )
    )
    f2_feats.update(
        calculate_strike_features(
            f2_id,
            f1_id,
            as_of_date,
            strike_breakdown_dict=strike_breakdown_dict,
            strike_defense_dict=strike_defense_dict,
            fighter_adjperf_history=fighter_adjperf_history,
            opponents_dict=opponents_dict,
        )
    )
    f1_feats.update(
        calculate_r1_features(
            f1_id,
            f2_id,
            as_of_date,
            r1_stats_dict=r1_stats_dict,
            opponents_dict=opponents_dict,
            fighter_adjperf_history=fighter_adjperf_history,
            strike_breakdown_dict=strike_breakdown_dict,
        )
    )
    f2_feats.update(
        calculate_r1_features(
            f2_id,
            f1_id,
            as_of_date,
            r1_stats_dict=r1_stats_dict,
            opponents_dict=opponents_dict,
            fighter_adjperf_history=fighter_adjperf_history,
            strike_breakdown_dict=strike_breakdown_dict,
        )
    )
    f1_feats.update(
        calculate_career_stats(
            f1_id,
            f2_id,
            "PRED",
            as_of_date,
            fighter_fights_dict=fighter_fights_dict,
            opponents_dict=opponents_dict,
            fighter_results_dict=fighter_results_dict,
            fight_decision_dict=fight_decision_dict,
            all_fight_stats=all_fight_stats,
        )
    )
    f2_feats.update(
        calculate_career_stats(
            f2_id,
            f1_id,
            "PRED",
            as_of_date,
            fighter_fights_dict=fighter_fights_dict,
            opponents_dict=opponents_dict,
            fighter_results_dict=fighter_results_dict,
            fight_decision_dict=fight_decision_dict,
            all_fight_stats=all_fight_stats,
        )
    )

    row = {}
    for k, v in f1_feats.items():
        row[f"f1_{k}"] = v
    for k, v in f2_feats.items():
        row[f"f2_{k}"] = v
    for k in f1_feats.keys():
        row[f"diff_{k}"] = row[f"f1_{k}"] - row[f"f2_{k}"]

    fighter_info = pd.read_sql(
        f"""
        SELECT fighter_id, reach, height, dob FROM fighters_v2
        WHERE fighter_id IN ('{f1_id}', '{f2_id}')
    """,
        conn,
    )

    def get_phys(fid):
        info = fighter_info[fighter_info["fighter_id"] == fid]
        if len(info) == 0:
            return {"reach": 72, "height": 70, "age": 30}
        info = info.iloc[0]
        return {
            "reach": parse_reach(info["reach"]) or 72,
            "height": parse_height(info["height"]) or 70,
            "age": parse_age(info["dob"], as_of_date) or 30,
        }

    f1_p, f2_p = get_phys(f1_id), get_phys(f2_id)
    row["age_diff"] = f1_p["age"] - f2_p["age"]
    row["age_ratio"] = f1_p["age"] / f2_p["age"]
    row["reach_diff"] = f1_p["reach"] - f2_p["reach"]
    row["reach_ratio"] = f1_p["reach"] / f2_p["reach"]
    row["height_diff"] = f1_p["height"] - f2_p["height"]
    row["height_ratio"] = f1_p["height"] / f2_p["height"]
    row["diff_ufc_age"] = _get_ufc_age(f1_id, as_of_date) - _get_ufc_age(
        f2_id, as_of_date
    )

    row["age_td_interaction"] = row.get("age_diff", 0) * row.get(
        "diff_td_avg_dec_avg", 0
    )
    row["age_td_adjperf_interaction"] = row.get("age_diff", 0) * row.get(
        "diff_td_avg_adjperf", 0
    )
    row["age_str_interaction"] = row.get("age_diff", 0) * row.get(
        "diff_str_acc_dec_avg", 0
    )
    row["age_winratio_interaction"] = row.get("age_diff", 0) * row.get(
        "diff_win_ratio", 0
    )
    row["ufc_age_td_interaction"] = row.get("diff_ufc_age", 0) * row.get(
        "diff_td_avg_dec_avg", 0
    )
    row["ufc_age_str_interaction"] = row.get("diff_ufc_age", 0) * row.get(
        "diff_str_acc_dec_avg", 0
    )
    row["td_ctrl_interaction"] = row.get("diff_td_avg_dec_avg", 0) * row.get(
        "diff_ctrl_time_per_min_dec_avg", 0
    )
    row["str_headdef_interaction"] = row.get("diff_str_acc_dec_avg", 0) * row.get(
        "diff_head_allowed_dec_avg", 0
    )

    return row


# ── Win prediction ────────────────────────────────────────────────────────────


def predict_fight(f1_name, f2_name, as_of_date=None):
    if as_of_date is None:
        as_of_date = datetime.now().strftime("%Y-%m-%d")

    conn = sqlite3.connect(DB_PATH)
    try:
        fighters_lookup = pd.read_sql("SELECT fighter_id, name FROM fighters_v2", conn)
        f1_match = _find_fighter(f1_name, fighters_lookup)
        f2_match = _find_fighter(f2_name, fighters_lookup)
        if f1_match is None or f2_match is None:
            return None

        f1_id, f1_db_name = f1_match["fighter_id"], f1_match["name"]
        f2_id, f2_db_name = f2_match["fighter_id"], f2_match["name"]

        row = _build_feature_row(f1_id, f2_id, as_of_date, conn)
        if row is None:
            return None

        X_pred = pd.DataFrame([row])
        for col in feature_cols:
            if col not in X_pred.columns:
                X_pred[col] = 0.0
        X_pred = X_pred[feature_cols].fillna(0)

        prob = model.predict_proba(X_pred)[0]
        pred = model.predict(X_pred)[0]
        winner = f1_db_name if pred == 1 else f2_db_name

        return {
            "f1": f1_db_name,
            "f2": f2_db_name,
            "f1_prob": round(float(prob[1]) * 100, 1),
            "f2_prob": round(float(prob[0]) * 100, 1),
            "pick": winner,
            "confidence": round(float(max(prob)) * 100, 1),
        }
    finally:
        conn.close()


# ── Method prediction ─────────────────────────────────────────────────────────


def predict_method(f1_name, f2_name, as_of_date=None):
    if as_of_date is None:
        as_of_date = datetime.now().strftime("%Y-%m-%d")

    conn = sqlite3.connect(DB_PATH)
    try:
        fighters_lookup = pd.read_sql("SELECT fighter_id, name FROM fighters_v2", conn)
        f1_match = _find_fighter(f1_name, fighters_lookup)
        f2_match = _find_fighter(f2_name, fighters_lookup)
        if f1_match is None or f2_match is None:
            return None

        f1_id = f1_match["fighter_id"]
        f2_id = f2_match["fighter_id"]

        row = _build_feature_row(f1_id, f2_id, as_of_date, conn)
        if row is None:
            return None

        # Win method history
        results_raw = pd.read_sql(
            """
            SELECT ff.fighter_id, ff.fight_id, ff.result, f.method
            FROM fight_fighters_v2 ff
            JOIN fights_v2 f ON ff.fight_id = f.fight_id
            WHERE ff.result = 'win'
        """,
            conn,
        )

        def get_finish_rates(fid):
            prev = results_raw[results_raw["fighter_id"] == fid]
            if len(prev) == 0:
                return {
                    "ko_rate": 0.0,
                    "sub_rate": 0.0,
                    "dec_rate": 0.0,
                    "finish_rate": 0.0,
                }
            total = len(prev)
            ko = prev["method"].str.contains("KO|TKO", na=False).sum()
            sub = prev["method"].str.contains("SUB", na=False, case=False).sum()
            dec = prev["method"].str.contains("DEC", na=False, case=False).sum()
            return {
                "ko_rate": ko / total,
                "sub_rate": sub / total,
                "dec_rate": dec / total,
                "finish_rate": (ko + sub) / total,
            }

        sub_feats = pd.read_sql(
            """
            SELECT ff.fighter_id,
                SUM(frs.sub_attempts) as total_sub_attempts,
                SUM(frs.td_landed) as total_td_landed,
                SUM(frs.ctrl_seconds) as total_ctrl_seconds,
                COUNT(DISTINCT ff.fight_id) as fights
            FROM fight_round_stats_v2 frs
            JOIN fight_fighters_v2 ff ON frs.fighter_id = ff.fighter_id
            GROUP BY ff.fighter_id
        """,
            conn,
        )

        def get_sub_stats(fid):
            r = sub_feats[sub_feats["fighter_id"] == fid]
            if len(r) == 0:
                return {
                    "sub_att_per_fight": 0.0,
                    "td_per_fight": 0.0,
                    "ctrl_per_fight": 0.0,
                }
            r = r.iloc[0]
            fights = max(r["fights"], 1)
            return {
                "sub_att_per_fight": r["total_sub_attempts"] / fights,
                "td_per_fight": r["total_td_landed"] / fights,
                "ctrl_per_fight": r["total_ctrl_seconds"] / fights,
            }

        f1_rates = get_finish_rates(f1_id)
        f2_rates = get_finish_rates(f2_id)
        f1_sub = get_sub_stats(f1_id)
        f2_sub = get_sub_stats(f2_id)

        row["f1_ko_rate"] = f1_rates["ko_rate"]
        row["f1_sub_rate"] = f1_rates["sub_rate"]
        row["f1_dec_rate"] = f1_rates["dec_rate"]
        row["f1_finish_rate"] = f1_rates["finish_rate"]
        row["f2_ko_rate"] = f2_rates["ko_rate"]
        row["f2_sub_rate"] = f2_rates["sub_rate"]
        row["f2_dec_rate"] = f2_rates["dec_rate"]
        row["f2_finish_rate"] = f2_rates["finish_rate"]
        row["diff_ko_rate"] = f1_rates["ko_rate"] - f2_rates["ko_rate"]
        row["diff_sub_rate"] = f1_rates["sub_rate"] - f2_rates["sub_rate"]
        row["diff_dec_rate"] = f1_rates["dec_rate"] - f2_rates["dec_rate"]
        row["diff_finish_rate"] = f1_rates["finish_rate"] - f2_rates["finish_rate"]
        row["max_ko_rate"] = max(f1_rates["ko_rate"], f2_rates["ko_rate"])
        row["max_sub_rate"] = max(f1_rates["sub_rate"], f2_rates["sub_rate"])
        row["max_finish_rate"] = max(f1_rates["finish_rate"], f2_rates["finish_rate"])
        row["f1_sub_att_per_fight"] = f1_sub["sub_att_per_fight"]
        row["f2_sub_att_per_fight"] = f2_sub["sub_att_per_fight"]
        row["f1_td_per_fight"] = f1_sub["td_per_fight"]
        row["f2_td_per_fight"] = f2_sub["td_per_fight"]
        row["f1_ctrl_per_fight"] = f1_sub["ctrl_per_fight"]
        row["f2_ctrl_per_fight"] = f2_sub["ctrl_per_fight"]
        row["diff_sub_att_per_fight"] = (
            f1_sub["sub_att_per_fight"] - f2_sub["sub_att_per_fight"]
        )
        row["diff_td_per_fight"] = f1_sub["td_per_fight"] - f2_sub["td_per_fight"]
        row["diff_ctrl_per_fight"] = f1_sub["ctrl_per_fight"] - f2_sub["ctrl_per_fight"]
        row["max_sub_att_per_fight"] = max(
            f1_sub["sub_att_per_fight"], f2_sub["sub_att_per_fight"]
        )
        row["max_td_per_fight"] = max(f1_sub["td_per_fight"], f2_sub["td_per_fight"])

        X_pred = pd.DataFrame([row])
        for col in method_feature_cols:
            if col not in X_pred.columns:
                X_pred[col] = 0.0
        X_pred = X_pred[method_feature_cols].fillna(0)

        probs = method_model.predict_proba(X_pred)[0]
        classes = method_le.classes_
        result = {c: round(float(p) * 100, 1) for c, p in zip(classes, probs)}
        result["pick"] = classes[probs.argmax()]
        return result

    finally:
        conn.close()
