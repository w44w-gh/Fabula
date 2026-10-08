#!/bin/bash
# Fabula をローカルサーバーで起動します（public/ を配信。Googleログイン等に必要）。
# このファイルをダブルクリックで実行 → ブラウザが自動で開きます。
# ウィンドウ（ターミナル）を閉じるとサーバーが停止します。
cd "$(dirname "$0")/public"
PORT=8733
( sleep 1; open "http://localhost:$PORT/index.html" ) &
echo "Fabula 起動中 → http://localhost:$PORT/index.html"
echo "（このウィンドウを閉じるとサーバーが止まります）"
python3 -m http.server $PORT --bind 127.0.0.1
