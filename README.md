# 🌱 Agriflow — ระบบรดน้ำอัจฉริยะด้วย ESP32

Agriflow วัดความชื้นดินด้วย ESP32 แล้วสั่ง servo เปิด/ปิดวาล์วน้ำเองตามเกณฑ์ที่ตั้งไว้
ดูค่าทุกอย่างแบบเรียลไทม์ผ่านหน้าเว็บ Dashboard จากมือถือหรือคอมได้เลย

## ระบบทำงานยังไง (อ่าน 30 วิ)

```
เซนเซอร์ความชื้น → ESP32 ตัดสินใจ → servo เปิด/ปิดวาล์ว
                        ↓ ส่งค่าทุก 5 วินาที (HTTPS)
              Server (Node.js) เก็บลง PostgreSQL + ส่งขึ้นหน้าเว็บแบบเรียลไทม์
                        ↓
              หน้าเว็บ Dashboard: ดูค่า / ตั้งค่า / สั่งเปิดวาล์วเอง
```

ตรรกะหลักมี 2 โหมด:

| โหมด | ทำงานยังไง |
|------|------------|
| **Auto** (ปกติ) | ดินแห้งต่ำกว่า threshold → เปิดวาล์ว → ครบเวลาที่ตั้ง → ปิด → พัก 5 นาทีก่อนเปิดรอบใหม่ได้ |
| **Manual** (กดปุ่ม) | กด "เปิดตอนนี้" วาล์วเปิดตามเวลาที่ตั้ง แล้วกลับ auto เอง กด "หยุด / Auto" คือยกเลิกทันที |

---

## 1. ของที่ต้องมี

**ฮาร์ดแวร์**
- ESP32 (เช่น ESP32-DEVKIT-V1)
- เซนเซอร์วัดความชื้นดินแบบ capacitive (analog)
- Servo หมุนวาล์ว (SG90 ตัวเล็กพอสำหรับวาล์วจิ๋ว บอลวาล์วจริงแนะนำ MG90S ขึ้นไป)
- แหล่งจ่ายไฟ **5V 2A แยกสำหรับ servo โดยเฉพาะ** + ต่อ GND ร่วมกับ ESP32
- คาปาซิเตอร์ 470–1000µF คร่อมขั้วไฟ servo (กันไฟตกตอน servo ออกตัว)
- WiFi 2.4 GHz

> ⚠️ ห้ามเอาไฟ servo จากขา 5V/3V3 บนบอร์ด ESP32 โดยตรง — ตอน servo ขยับพร้อม WiFi ส่งข้อมูล บอร์ดจะไฟตกแล้วรีบูตเอง ดูเหมือนระบบไม่เสถียรทั้งที่โค้ดปกติ

**ซอฟต์แวร์**
- Node.js 14+ / Arduino IDE + บอร์ด ESP32 / PostgreSQL (หรือ Supabase)

## 2. ต่อวงจร

| อุปกรณ์ | ต่อขา |
|---------|-------|
| เซนเซอร์ความชื้น | GPIO 34 |
| Servo (สายสัญญาณ) | GPIO 18 |
| Servo (ไฟ +/-) | 5V แยก / GND ร่วมกับ ESP32 |
| ปุ่มรีเซ็ต WiFi | ปุ่ม BOOT บนบอร์ด (GPIO 0) กดค้าง ~3 วิ |

## 3. ลง firmware ESP32

1. เปิด Arduino IDE → ติดตั้งบอร์ด ESP32 + ไลบรารี `ESP32Servo`
2. เปิดไฟล์ `moisture-sensor_code/ESP32_SmartSprinkler/ESP32_SmartSprinkler.ino`
3. **คาลิเบรตเซนเซอร์** — แก้ 2 ค่านี้ให้ตรงเซนเซอร์ของตัวเอง:
   ```cpp
   const int dryValue = 3200;  // ค่าตอนดินแห้ง (อ่านจาก Serial Monitor)
   const int wetValue = 800;   // ค่าตอนจุ่มน้ำ
   ```
4. **จูน servo** (ถ้ามันกระฉากหรือชนสต็อปเปอร์วาล์ว):
   ```cpp
   const int VALVE_CLOSED_ANGLE = 0;
   const int VALVE_OPEN_ANGLE = 70;  // 90 แล้วกระแทกให้ลดลงมา
   ```
   โค้ดจะค่อยๆ หมุนทีละนิด (sweep) ไม่สั่งกระชากทีเดียวอยู่แล้ว
5. เสียบสาย USB → กด **Upload** → เปิด Serial Monitor (115200) ดู log

## 4. ตั้ง WiFi ครั้งแรก (ทำครั้งเดียว จำลงเครื่อง)

1. เปิดเครื่องครั้งแรก ESP32 จะปล่อย WiFi ชื่อ **`Agriflow-Setup`** รหัส **`setup123`**
2. ต่อมือถือเข้าชื่อนี้ หน้า setup จะเด้งขึ้นมาเอง (ถ้าไม่เด้ง เปิดเบราว์เซอร์ไป `http://192.168.4.1`)
3. เลือก WiFi บ้าน + ใส่รหัส → กด Save → บอร์ดรีบูตแล้วต่อเน็ตเอง
4. เปลี่ยน WiFi ทีหลังมี 2 ทาง: กดปุ่ม **BOOT** ค้าง 3 วินาที หรือกดปุ่ม **Change WiFi** บนหน้าเว็บ

> เน็ตหลุดชั่วคราว (เราเตอร์รีบูต) บอร์ดจะลองต่อใหม่เอง รหัสไม่หาย ไม่ต้องตั้งใหม่

## 5. รัน server ที่เครื่องตัวเอง

```bash
npm install
```

สร้างไฟล์ `.env`:
```env
PORT=10000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/agriflow
RESET_TOKEN=ตั้งรหัสเองไว้ยืนยันปุ่ม-Change-WiFi
```

```bash
npm run dev    # พัฒนา
npm start      # ใช้งานจริง
```

เปิด `http://localhost:10000` — ตารางใน database สร้างให้อัตโนมัติครั้งแรกที่ต่อติด
ถ้าไม่มี `DATABASE_URL` ระบบก็รันได้ แต่ข้อมูลจะอยู่แค่ใน memory (รีสตาร์ตทีหาย)

## 6. Deploy ขึ้น Render

1. ต่อ GitHub repo เข้า Render → สร้าง Web Service (branch `main`) แบบ auto-deploy
2. ตั้ง Environment variables:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = ค่า connection string ของ Postgres/Supabase (**ห้ามลืม** ไม่งั้นหน้า `/api/health` จะขึ้น `db: disconnected` แล้วข้อมูลหายทุกครั้งที่ restart)
   - `RESET_TOKEN` = รหัสเดียวกับที่จะกรอกในหน้าเว็บ
3. push โค้ด → รอหน้า Events ขึ้น `Live` ตรง commit ล่าสุด

> Render แผนฟรีจะ sleep ถ้าไม่มีคนเข้านานๆ เข้าครั้งแรกหลังทิ้งไว้นานจะโหลดช้า ~1 นาที ถือว่าปกติ

---

## 7. ใช้หน้า Dashboard

- **Soil Moisture** — เปอร์เซ็นต์ความชื้น + แถบสีบอกระดับดิน (Very Dry → Saturated)
- **Valve Control** — สถานะ `Idle/Watering` + เวลานับถอยหลัง
  - ปุ่ม **เปิดตอนนี้** = สั่งเปิดตามเวลาที่ตั้ง แล้วกลับ auto เอง
  - ปุ่ม **หยุด / Auto** = ยกเลิกคำสั่ง manual ทันที
- **พืชที่ปลูก** — เลือกชนิดพืชแล้ว threshold + เวลารดจะถูกตั้งตามงานวิจัยให้ กด Save เพื่อใช้ ขยับ slider เองเมื่อไหร่จะกลายเป็น "กำหนดเอง"
- **Open Threshold** — ความชื้นต่ำกว่านี้ถึงเปิดวาล์ว
- **Watering Duration** — เปิดวาล์วนานกี่นาที
- **Change WiFi** — สั่งให้ ESP32 ล้าง WiFi แล้วเปิดโหมดตั้งค่าใหม่ (ครั้งแรกเว็บจะถาม `RESET_TOKEN` จำไว้ในเครื่องให้)
- **History / Recent Readings** — กราฟกับตารางย้อนหลัง (สูงสุด 200 จุด)

## 8. API (สำหรับอ้างอิง)

```
GET  /api/health      → { status, db: connected|disconnected }
GET  /api/crops       → รายการพืช + threshold/นาทีที่แนะนำ
GET  /api/config      → config ปัจจุบัน (+ valveOverride ถ้ามี)
POST /api/config      → { openThreshold, wateringMinutes, cropId }
POST /api/valve       → { action: open | close | auto }
POST /api/reset-wifi  → ต้องมี header x-reset-token (ถ้า server ตั้ง RESET_TOKEN ไว้)
POST /api/sensor      → ESP32 ส่ง { raw, moisture, valve, device, ... }
GET  /api/data        → { latest, history, devices, config }
GET  /api/events      → SSE stream เรียลไทม์
```

---

## 9. โครงไฟล์

```
├── server.js                        # Server + API + เสิร์ฟหน้าเว็บ
├── index.html / style.css / script.js  # Dashboard
├── render.yaml / Procfile / package.json
└── moisture-sensor_code/ESP32_SmartSprinkler/
    ├── ESP32_SmartSprinkler.ino     # เฟิร์มแวร์หลัก (เซนเซอร์+servo+ส่งข้อมูล)
    └── config_portal.h              # หน้า setup WiFi (AP Agriflow-Setup)
```

## 10. แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุที่พบบ่อย + ทางแก้ |
|------|--------------------------|
| `/api/health` ขึ้น `db: disconnected` | ยังไม่ตั้ง `DATABASE_URL` บน Render → ตั้งแล้ว redeploy |
| กดปุ่ม manual แล้ววาล์วไม่ขยับ | 1) ยังไม่ push โค้ดใหม่ขึ้น Render 2) browser จำ JS เก่า → `Ctrl+Shift+R` 3) ESP32 ยัง firmware เก่า → flash ใหม่ |
| ESP32 รีบูตเอง / ต่อๆ หลุดๆ | ไฟ servo ไม่พอ → ใช้ 5V แยก + GND ร่วม + คร่อม C 470–1000µF |
| Servo กระฉาก / ครางค้าง | ลด `VALVE_OPEN_ANGLE` (เช่น 90→70) อย่าให้ชนสต็อปเปอร์ เช็คน็อตฮอร์น วาล์วใหญ่เกินแรง SG90 ให้เปลี่ยนรุ่นทอร์กสูง |
| ค่าความชื้นค้าง 0% หรือ 100% | `dryValue/wetValue` ไม่ตรงเซนเซอร์ → อ่านค่าจริงจาก Serial แล้วแก้ |
| หน้าเว็บเพิ่ง deploy แต่ยังเห็นของเก่า | hard-refresh (`Ctrl+Shift+R`) หรือเปิด Incognito |
| ตั้ง WiFi ใหม่ไม่ได้ | กด BOOT ค้าง 3 วิให้ AP `Agriflow-Setup` เปิด หรือใช้ปุ่ม Change WiFi + `RESET_TOKEN` |
| เข้าเว็บครั้งแรกช้ามาก | Render free เพิ่งตื่นจาก sleep รอ ~1 นาทีแล้ว refresh |

---

**Made with 🌱 for gardeners, by gardeners.**
