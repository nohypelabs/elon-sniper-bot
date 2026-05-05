# Evaluasi Sniper Bot — 5 Mei 2026
> Paper Trading | Sumber: sniper-trades-2026-05-05 (3).csv

---

## Ringkasan Performa

| Metrik | Nilai |
|---|---|
| Total Trade (complete) | 24 |
| Menang | 16 |
| Kalah | 8 |
| **Win Rate** | **66.7%** |
| **Total PnL** | **+4.52 SOL ≈ +$813** |
| Avg Win per trade | +0.40 SOL |
| Avg Loss per trade | -0.23 SOL |
| **Profit Factor** | **3.41x** ✅ |
| Hold time rata-rata | < 1 menit |
| Buy Amount per trade | 0.5 SOL |
| Session duration | ~7 jam |

> Profit Factor 3.41 artinya setiap 1 SOL loss, bot menghasilkan 3.41 SOL profit. Angka >2 sudah bagus.

---

## Breakdown Exit Reason

| Reason | Count | PnL |
|---|---|---|
| TP1 (+30%) | 18x | +4.64 SOL |
| TP2 (+50%) | 12x | +1.72 SOL |
| SL Normal | 4x | -0.51 SOL |
| **Rug Pull (SL >40%)** | **4x** | **-1.37 SOL** |
| Manual Sell | 1x | +0.04 SOL |

---

## Analisis Loss

### Rug Pulls (masalah utama)
4 dari 8 loss adalah rug pull — dump >40% dalam 1 transaksi, SL tidak bisa catch di -25%.

| Token | Loss % | Loss SOL |
|---|---|---|
| 币安好友 | -77.6% | -0.388 SOL |
| FLAD | -72.0% | -0.360 SOL |
| horse | -63.1% | -0.315 SOL |
| VØCOIN | -60.3% | -0.302 SOL |
| **Total** | | **-1.365 SOL** |

> Kalau 4 rug ini tidak terjadi, PnL = +5.88 SOL ≈ $1,058

### Normal SL (acceptable)
4 loss yang SL-nya terpotong normal di sekitar -25%:

| Token | Loss SOL |
|---|---|
| hullo | -0.130 SOL |
| TRICERATOPS | -0.127 SOL |
| Deer | -0.127 SOL |
| fork | -0.128 SOL |

Normal SL bekerja dengan benar — loss terkontrol di ~0.13 SOL per trade.

---

## Top Winners

| Token | PnL | Hold Time | Exit |
|---|---|---|---|
| Bartleby | +1.18 SOL | 18 detik | TP1 + TP2 |
| please buy | +0.98 SOL | 42 detik | TP1 + TP2 |
| Devil | +0.69 SOL | 1 menit | TP1 + TP2 |
| LeBron | +0.54 SOL | 1 menit | TP1 + TP2 |
| ESXYX | +0.50 SOL | 30 detik | TP1 + TP2 |

> Semua top winner adalah token yang hit TP1 DAN TP2 — strategi multi-level TP terbukti efektif.

---

## Saran Optimasi (Prioritas)

### 🔴 Priority 1 — Kurangi Damage dari Rug Pull

**Masalah:** Rug pull tidak bisa dicegah (terjadi dalam 1 block Solana, ~400ms).
**Solusi:** Kecilkan buy amount biar worst-case rug tidak terlalu dalam.

```env
# .env — ubah ini
BUY_AMOUNT_SOL=0.25   # dari 0.5 → worst case rug -77% = -0.19 SOL (bukan -0.38)
```

Dengan 0.25 SOL/trade:
- Worst rug: -0.19 SOL (sebelumnya -0.39 SOL)
- Best win (Bartleby-style): +0.59 SOL (sebelumnya +1.18 SOL)
- Total PnL tetap positif, drawdown per-trade lebih kecil

---

### 🟡 Priority 2 — Perketat Filter Token Sebelum Beli

Bot saat ini beli hampir semua token yang match keyword tweet. Tambah filter:

**a) PUMP_SECURITY_CHECK sudah ON — pastikan tetap ON**
```env
PUMP_SECURITY_CHECK=true
```

**b) Tambah blacklist kata-kata rug common:**
```env
PUMP_BLACKLIST_WORDS=test,rug,scam,honeypot,fake,copy,dupe,coin,token,airdrop,free
```

**c) Naikkan min dev buy untuk PumpFun snipe:**
```env
PUMP_MIN_DEV_BUY_SOL=0.5   # dari 0.3 → dev lebih committed
```

---

### 🟡 Priority 3 — Batasi Max Posisi Bersamaan

Di session ini bot buka 5-6 posisi sekaligus. Kalau semua kena rug bersamaan, exposure besar.

```env
PUMP_MAX_POSITIONS=3   # dari 5 → max 3 posisi sekaligus
```

Dengan 0.25 SOL × 3 posisi = **max exposure 0.75 SOL** pada satu waktu.

---

### 🟢 Priority 4 — Tambah Max Hold yang Lebih Ketat

Dari data, semua winner exit dalam < 2 menit. Token yang masih hold >5 menit cenderung tidak pump lagi.

```env
PUMP_MAX_HOLD_MINUTES=5   # dari 30 → cut loss lebih cepat kalau tidak pump
```

---

### 🟢 Priority 5 — Evaluasi Setelah 100 Trade

Sample 24 trade masih terlalu kecil untuk konfirmasi statistik. Target 100 trade paper sebelum go live.

- Win rate 66% pada 24 trade bisa jadi keberuntungan
- Pada 100 trade, kalau WR masih >55% dan PF >2.0 → aman untuk go live

---

## Konfigurasi yang Disarankan (Low Risk Mode)

```env
BUY_AMOUNT_SOL=0.25
PUMP_MAX_POSITIONS=3
PUMP_MAX_HOLD_MINUTES=5
PUMP_MIN_DEV_BUY_SOL=0.5
PUMP_SECURITY_CHECK=true
STOP_LOSS_PERCENT=25
TP1_PERCENT=30
TP1_SELL_PERCENT=80
TP2_PERCENT=50
```

---

## Kesimpulan

Strategi **sudah profitable** dengan bukti nyata. Yang perlu diperbaiki bukan algoritmanya, tapi **manajemen risiko per-trade**:

- TP1/TP2 bekerja sempurna ✅
- SL normal bekerja ✅
- Rug pull adalah satu-satunya variabel yang tidak terkontrol ⚠️
- Solusi: posisi lebih kecil, max posisi lebih sedikit

**Rekomendasi: lanjut paper dengan konfigurasi low risk di atas sampai 100 trade, baru go live.**
