import sys

sys.path.append(r"C:\Users\Sarthak\Documents\ML\fighter-beta\mma\notebooks")

import sqlite3
import pandas as pd
from src.predict import predict_fight, predict_method

DB_PATH = r"C:\Users\Sarthak\Documents\ML\fighter-beta\mma_fighters.db"


def precompute():
    conn = sqlite3.connect(DB_PATH)

    # Get all 2026 fights not yet predicted
    fights = pd.read_sql(
        """
        SELECT
            f.fight_id,
            f.event_date,
            ff1.fighter_id as f1_id,
            fv1.name as f1_name,
            ff2.fighter_id as f2_id,
            fv2.name as f2_name
        FROM fights_v2 f
        JOIN fight_fighters_v2 ff1 ON f.fight_id = ff1.fight_id AND ff1.corner = 'fighter_1'
        JOIN fight_fighters_v2 ff2 ON f.fight_id = ff2.fight_id AND ff2.corner = 'fighter_2'
        JOIN fighters_v2 fv1 ON ff1.fighter_id = fv1.fighter_id
        JOIN fighters_v2 fv2 ON ff2.fighter_id = fv2.fighter_id
        WHERE f.event_date >= '2023-01-01'
        AND f.event_date < date('now')
        AND fv1.is_stub = 0
        AND fv2.is_stub = 0
        AND f.fight_id NOT IN (SELECT fight_id FROM model_predictions)
        ORDER BY f.event_date ASC
    """,
        conn,
    )

    print(f"Found {len(fights)} fights to predict")

    success = 0
    failed = 0

    for _, fight in fights.iterrows():
        try:
            pred = predict_fight(
                fight["f1_name"], fight["f2_name"], as_of_date=fight["event_date"]
            )
            method = predict_method(
                fight["f1_name"], fight["f2_name"], as_of_date=fight["event_date"]
            )

            if pred and method:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO model_predictions
                    (fight_id, f1_name, f2_name, pick, confidence,
                     f1_prob, f2_prob, method_decision, method_ko,
                     method_sub, method_pick)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        fight["fight_id"],
                        fight["f1_name"],
                        fight["f2_name"],
                        pred["pick"],
                        pred["confidence"],
                        pred["f1_prob"],
                        pred["f2_prob"],
                        method["Decision"],
                        method["KO/TKO"],
                        method["Submission"],
                        method["pick"],
                    ),
                )
                conn.commit()
                success += 1
                print(f"✔ {fight['f1_name']} vs {fight['f2_name']}")
        except Exception as e:
            failed += 1
            print(f"✗ {fight['f1_name']} vs {fight['f2_name']}: {e}")

    conn.close()
    print(f"\nDone. Success: {success} Failed: {failed}")


if __name__ == "__main__":
    precompute()
