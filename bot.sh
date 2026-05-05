#!/bin/bash
# Elon Sniper Bot — management script
# Usage: ./bot.sh [command]

BOT_DIR="/DataPopOS/projects/elon-sniper-bot"
SERVICE="elon-sniper"

cd "$BOT_DIR" || exit 1

case "$1" in
  start)
    echo "▶ Starting bot (local)..."
    kill $(lsof -t -i:3001) 2>/dev/null
    pnpm dev
    ;;

  stop)
    echo "⏹ Killing bot process..."
    kill $(lsof -t -i:3001) 2>/dev/null && echo "Done." || echo "Tidak ada proses di port 3001."
    ;;

  restart)
    echo "🔄 Restarting via systemd..."
    sudo systemctl restart $SERVICE
    ;;

  status)
    sudo systemctl status $SERVICE --no-pager
    ;;

  log)
    echo "📋 Live log (Ctrl+C untuk keluar)..."
    sudo journalctl -u $SERVICE -f --no-pager
    ;;

  log-error)
    echo "❌ Error log..."
    sudo journalctl -u $SERVICE --no-pager | grep -E "ERROR|error|Error|warn|WARN"
    ;;

  build)
    echo "🔨 Building dashboard..."
    cd dashboard && pnpm build && cd ..
    echo "✅ Dashboard built."
    ;;

  enable)
    echo "⚙ Enabling systemd service (auto-start on boot)..."
    sudo systemctl enable $SERVICE
    ;;

  disable)
    echo "⚙ Disabling systemd service..."
    sudo systemctl disable $SERVICE
    ;;

  killport)
    kill $(lsof -t -i:3001) 2>/dev/null && echo "Port 3001 freed." || echo "Port 3001 sudah kosong."
    ;;

  *)
    echo ""
    echo "Elon Sniper Bot — Commands:"
    echo ""
    echo "  ./bot.sh start       → Jalankan bot di terminal (local dev)"
    echo "  ./bot.sh stop        → Kill proses bot di port 3001"
    echo "  ./bot.sh restart     → Restart via systemd"
    echo "  ./bot.sh status      → Cek status systemd service"
    echo "  ./bot.sh log         → Live log dari systemd"
    echo "  ./bot.sh log-error   → Filter log error/warning saja"
    echo "  ./bot.sh build       → Build ulang dashboard React"
    echo "  ./bot.sh enable      → Auto-start bot saat boot"
    echo "  ./bot.sh disable     → Disable auto-start"
    echo "  ./bot.sh killport    → Bebaskan port 3001"
    echo ""
    ;;
esac
