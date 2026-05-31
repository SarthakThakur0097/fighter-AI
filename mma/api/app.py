import os
import sys
import sqlite3

import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Path setup — add notebooks dir so src.predict can be imported
# ---------------------------------------------------------------------------
sys.path.insert(0, "/app/mma/notebooks")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../notebooks")))

from src.predict import predict_fight, predict_method

# ---------------------------------------------------------------------------
# App & config
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)

# Single source of truth for DB path.
# Set DB_PATH=/app/mma_fighters.db in Railway → Variables.
DB_PATH = os.environ.get("DB_PATH", "/app/mma_fighters.db")

print(f"[startup] DB_PATH: {DB_PATH}", flush=True)
print(f"[startup] DB exists: {os.path.exists(DB_PATH)}", flush=True)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------
def get_conn():
    """Return a sqlite3 connection to the shared DB."""
    return sqlite3.connect(DB_PATH)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/accuracy", methods=["GET"])
def accuracy():
    conn = get_conn()
    try:
        fights = pd.read_sql(
            """
            SELECT
                mp.pick,
                ff1.result  AS f1_result,
                fv1.name    AS f1_name,
                fv2.name    AS f2_name
            FROM model_predictions mp
            JOIN fights_v2          f   ON mp.fight_id  = f.fight_id
            JOIN fight_fighters_v2  ff1 ON f.fight_id   = ff1.fight_id AND ff1.corner = 'fighter_1'
            JOIN fighters_v2        fv1 ON ff1.fighter_id = fv1.fighter_id
            JOIN fight_fighters_v2  ff2 ON f.fight_id   = ff2.fight_id AND ff2.corner = 'fighter_2'
            JOIN fighters_v2        fv2 ON ff2.fighter_id = fv2.fighter_id
            WHERE f.event_date >= '2023-01-01'
              AND f.event_date  < date('now')
              AND f.method NOT IN ('S-DEC', 'M-DEC', 'Overturned', 'CNC', 'DQ', 'Other')
            ORDER BY f.event_date DESC
            LIMIT 100
            """,
            conn,
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

    total = len(fights)
    correct = sum(
        1
        for _, fight in fights.iterrows()
        if fight["pick"] == (fight["f1_name"] if fight["f1_result"] == "win" else fight["f2_name"])
    )

    return jsonify(
        {
            "correct": correct,
            "total": total,
            "accuracy": round(correct / total * 100, 1) if total > 0 else 0,
        }
    )


@app.route("/results", methods=["GET"])
def results():
    # Safely cast limit to int to prevent SQL injection
    try:
        limit = int(request.args.get("limit", 5))
    except ValueError:
        limit = 5

    conn = get_conn()
    try:
        events = pd.read_sql(
            """
            SELECT DISTINCT f.event_name, f.event_date
            FROM fights_v2 f
            JOIN model_predictions mp ON f.fight_id = mp.fight_id
            WHERE f.event_date >= '2026-01-01'
              AND f.event_date  < date('now')
              AND f.event_name IS NOT NULL
            ORDER BY f.event_date DESC
            LIMIT ?
            """,
            conn,
            params=[limit],
        )

        result = []
        for _, event in events.iterrows():
            fights = pd.read_sql(
                """
                SELECT
                    f.fight_id,
                    f.method,
                    f.ending_round,
                    f.ending_time,
                    fv1.name        AS f1_name,
                    ff1.result      AS f1_result,
                    fv2.name        AS f2_name,
                    mp.pick,
                    mp.confidence,
                    mp.f1_prob,
                    mp.f2_prob,
                    mp.method_decision,
                    mp.method_ko,
                    mp.method_sub,
                    mp.method_pick
                FROM fights_v2 f
                JOIN fight_fighters_v2  ff1 ON f.fight_id    = ff1.fight_id AND ff1.corner = 'fighter_1'
                JOIN fight_fighters_v2  ff2 ON f.fight_id    = ff2.fight_id AND ff2.corner = 'fighter_2'
                JOIN fighters_v2        fv1 ON ff1.fighter_id = fv1.fighter_id
                JOIN fighters_v2        fv2 ON ff2.fighter_id = fv2.fighter_id
                JOIN model_predictions  mp  ON f.fight_id    = mp.fight_id
                WHERE f.event_name = ?
                  AND fv1.is_stub  = 0
                  AND fv2.is_stub  = 0
                ORDER BY f.ending_round DESC, f.ending_time DESC
                """,
                conn,
                params=[event["event_name"]],
            )

            fight_results = []
            for _, fight in fights.iterrows():
                actual_winner = fight["f1_name"] if fight["f1_result"] == "win" else fight["f2_name"]
                fight_results.append(
                    {
                        "f1": fight["f1_name"],
                        "f2": fight["f2_name"],
                        "pick": fight["pick"],
                        "conf": round(fight["confidence"], 1),
                        "f1_prob": round(fight["f1_prob"], 1),
                        "f2_prob": round(fight["f2_prob"], 1),
                        "actual_winner": actual_winner,
                        "method": fight["method"],
                        "method_pred": {
                            "Decision": round(fight["method_decision"], 1),
                            "KO/TKO": round(fight["method_ko"], 1),
                            "Submission": round(fight["method_sub"], 1),
                            "pick": fight["method_pick"],
                        },
                        "correct": fight["pick"] == actual_winner,
                    }
                )

            if fight_results:
                correct_count = sum(1 for f in fight_results if f["correct"])
                result.append(
                    {
                        "event": event["event_name"],
                        "date": event["event_date"],
                        "correct": correct_count,
                        "total": len(fight_results),
                        "fights": fight_results,
                    }
                )

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

    return jsonify(result)


@app.route("/predict", methods=["GET"])
def predict():
    f1 = request.args.get("f1")
    f2 = request.args.get("f2")

    if not f1 or not f2:
        return jsonify({"error": "f1 and f2 are required"}), 400

    result = predict_fight(f1, f2)
    if result is None:
        return jsonify({"error": "Could not generate prediction"}), 404

    return jsonify(result)


@app.route("/predict/method", methods=["GET"])
def predict_method_endpoint():
    f1 = request.args.get("f1")
    f2 = request.args.get("f2")

    if not f1 or not f2:
        return jsonify({"error": "f1 and f2 are required"}), 400

    result = predict_method(f1, f2)
    if result is None:
        return jsonify({"error": "Could not generate prediction"}), 404

    return jsonify(result)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)