from flask import Flask, jsonify, request
import sys
sys.path.append(r'C:\Users\Sarthak\Documents\ML\fighter-beta\mma\notebooks')

from src.predict import predict_fight

app = Flask(__name__)

@app.route('/predict', methods=['GET'])
def predict():
    f1 = request.args.get('f1')
    f2 = request.args.get('f2')

    if not f1 or not f2:
        return jsonify({'error': 'f1 and f2 are required'}), 400

    result = predict_fight(f1, f2)

    if result is None:
        return jsonify({'error': 'Could not generate prediction'}), 404

    return jsonify(result)

if __name__ == '__main__':
    app.run(debug=True)