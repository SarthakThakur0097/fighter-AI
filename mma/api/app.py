import sys
import os

sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../notebooks"))
)

from flask import Flask, jsonify, request
from src.predict import predict_fight, predict_method

# Add notebooks directory to path so src module can be found
sys.path.append(os.path.join(os.path.dirname(__file__), "../../mma/notebooks"))
# Also try absolute path from app root
sys.path.append("/app/mma/notebooks")


sys.path.append(r"C:\Users\Sarthak\Documents\ML\fighter-beta\mma\notebooks")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.abspath(os.path.join(BASE_DIR, "../../../mma_fighters.db"))

app = Flask(__name__)

from flask_cors import CORS

app = Flask(__name__)
CORS(app)


@app.route("/accuracy", methods=["GET"])
def accuracy():
    import sqlite3
    import pandas as pd

    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

    DB_PATH = os.environ.get(
        "DB_PATH", os.path.abspath(os.path.join(BASE_DIR, "../../mma_fighters.db"))
    )

    conn = sqlite3.connect(DB_PATH)

    fights = pd.read_sql(
        """
        SELECT
            mp.pick,
            ff1.result as f1_result,
            fv1.name as f1_name,
            fv2.name as f2_name
        FROM model_predictions mp
        JOIN fights_v2 f ON mp.fight_id = f.fight_id
        JOIN fight_fighters_v2 ff1 ON f.fight_id = ff1.fight_id AND ff1.corner = 'fighter_1'
        JOIN fighters_v2 fv1 ON ff1.fighter_id = fv1.fighter_id
        JOIN fight_fighters_v2 ff2 ON f.fight_id = ff2.fight_id AND ff2.corner = 'fighter_2'
        JOIN fighters_v2 fv2 ON ff2.fighter_id = fv2.fighter_id
        WHERE f.event_date >= '2023-01-01'
        AND f.event_date < date('now')
        AND f.method NOT IN ('S-DEC', 'M-DEC', 'Overturned', 'CNC', 'DQ', 'Other')
        ORDER BY f.event_date DESC
        LIMIT 100
    """,
        conn,
    )

    correct = 0
    total = len(fights)

    for _, fight in fights.iterrows():
        actual_winner = (
            fight["f1_name"] if fight["f1_result"] == "win" else fight["f2_name"]
        )
        if fight["pick"] == actual_winner:
            correct += 1

    conn.close()

    return jsonify(
        {
            "correct": correct,
            "total": total,
            "accuracy": round((correct / total * 100), 1) if total > 0 else 0,
        }
    )


@app.route("/results", methods=["GET"])
def results():
    import sqlite3
    import pandas as pd

    conn = sqlite3.connect(DB_PATH)
    limit = request.args.get("limit", 5)

    events = pd.read_sql(
        f"""
        SELECT DISTINCT f.event_name, f.event_date
        FROM fights_v2 f
        JOIN model_predictions mp ON f.fight_id = mp.fight_id
        WHERE f.event_date >= '2026-01-01'
        AND f.event_date < date('now')
        AND f.event_name IS NOT NULL
        ORDER BY f.event_date DESC
        LIMIT {limit}
    """,
        conn,
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
                fv1.name as f1_name,
                ff1.result as f1_result,
                fv2.name as f2_name,
                mp.pick,
                mp.confidence,
                mp.f1_prob,
                mp.f2_prob,
                mp.method_decision,
                mp.method_ko,
                mp.method_sub,
                mp.method_pick
            FROM fights_v2 f
            JOIN fight_fighters_v2 ff1 ON f.fight_id = ff1.fight_id AND ff1.corner = 'fighter_1'
            JOIN fight_fighters_v2 ff2 ON f.fight_id = ff2.fight_id AND ff2.corner = 'fighter_2'
            JOIN fighters_v2 fv1 ON ff1.fighter_id = fv1.fighter_id
            JOIN fighters_v2 fv2 ON ff2.fighter_id = fv2.fighter_id
            JOIN model_predictions mp ON f.fight_id = mp.fight_id
            WHERE f.event_name = ?
            AND fv1.is_stub = 0
            AND fv2.is_stub = 0
            ORDER BY f.ending_round DESC, f.ending_time DESC
        """,
            conn,
            params=[event["event_name"]],
        )

        fight_results = []
        for _, fight in fights.iterrows():
            actual_winner = (
                fight["f1_name"] if fight["f1_result"] == "win" else fight["f2_name"]
            )
            correct = fight["pick"] == actual_winner
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
                    "correct": correct,
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
