# 🌱 Agriflow - Smart Soil Moisture Monitoring System

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Status](https://img.shields.io/badge/status-active-brightgreen)]()

Agriflow is an open-source IoT solution that helps home gardeners and small-scale farmers automatically monitor soil moisture and control watering systems. Monitor your plants from anywhere using a beautiful, mobile-friendly dashboard with real-time sensor data, watering controls, and moisture history tracking.

## ✨ Features

- **Real-time Soil Moisture Monitoring**: Get instant updates from ESP32-based moisture sensors
- **Smart Watering Control**: Set custom thresholds to automatically trigger watering
- **Beautiful Dashboard**: Responsive, accessible web interface designed for outdoor use
- **Mobile-First Design**: Use on phone, tablet, or desktop while tending your garden
- **Moisture History**: Track soil moisture trends over time
- **Configurable Watering Duration**: Set how long the valve stays open (in minutes)
- **Status Indicators**: Clear visual feedback on valve state, moisture levels, and alerts
- **WCAG AAA Accessible**: Readable in sunlight with large touch targets for easy interaction
- **Secure**: HTTPS-ready, rate-limited API, secure data transmission
- **Self-Hosted**: Deploy on Render, your own server, or local network

## 🎯 Who Is This For?

- **Home Gardeners**: Keep potted plants, balcony gardens, and small beds healthy
- **Small-Scale Farmers**: Monitor multiple garden areas with individual sensors
- **Tech Enthusiasts**: Learn IoT, embedded systems, and full-stack web development
- **Open-Source Contributors**: Fork, modify, and improve for your own use case

## 📋 Requirements

### Hardware
- **ESP32 Microcontroller** (e.g., ESP32-DEVKIT-V1)
- **Capacitive Soil Moisture Sensor** (analog, 0-3.3V)
- **Servo Motor** (for valve control, e.g., SG90)
- **5V Power Supply** (for servo and ESP32)
- **WiFi Network** (2.4 GHz)

### Software
- **Node.js** (v14 or higher)
- **PostgreSQL** (v12 or higher, or Supabase for cloud)
- **Arduino IDE** (for uploading firmware to ESP32)
- **Modern Web Browser** (Chrome, Firefox, Safari, Edge)

## 🚀 Quick Start

### Step 1: Set Up Hardware

1. **Wire the ESP32**:
   - Moisture Sensor → GPIO 34 (analog input)
   - Servo Motor → GPIO 18 (PWM output)
   - Power both components from 5V source

2. **Calibrate Your Sensor**:
   - Edit `moisture-sensor_code/ESP32_SmartSprinkler/ESP32_SmartSprinkler.ino`
   - Update `dryValue` (when sensor is in dry soil) and `wetValue` (when in water)
   - Example:
     ```cpp
     const int dryValue = 3200;   // Dry soil reading
     const int wetValue = 800;    // Wet soil reading
     ```

3. **Upload Firmware**:
   - Open Arduino IDE
   - Install ESP32 board: `Tools → Boards Manager → ESP32`
   - Open the `.ino` file
   - Connect ESP32 via USB
   - Click **Upload** (⏤►)
   - Open Serial Monitor to see boot logs

### Step 2: Configure WiFi

On first boot, ESP32 will create a WiFi access point:
- **SSID**: `Agriflow-AP`
- **Password**: `12345678`
- Connect from your phone/computer
- Visit `192.168.4.1` in browser
- Enter your WiFi credentials and server IP/URL
- Restart the device

### Step 3: Set Up the Backend Server

1. **Clone or Download This Repository**

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Create `.env` File**:
   ```env
   PORT=10000
   NODE_ENV=development
   DATABASE_URL=postgresql://user:password@localhost:5432/agriflow
   RENDER_EXTERNAL_URL=https://your-app.onrender.com
   ```

4. **Create PostgreSQL Database**:
   ```bash
   createdb agriflow
   ```

5. **Start the Server** (Development):
   ```bash
   npm run dev
   ```
   
   Or Production:
   ```bash
   npm start
   ```

6. **Access the Dashboard**:
   - Open `http://localhost:10000` in your browser

### Step 4: Configure Sensor Settings

In the dashboard:
1. Navigate to **Settings** (⚙️ icon)
2. Set **Watering Threshold**: e.g., 40% (opens valve when moisture drops below this)
3. Set **Watering Duration**: e.g., 3 minutes (how long to water)
4. Save settings

## 📱 Using the Dashboard

### Main Screen
- **Moisture Gauge**: Current soil moisture percentage
- **Valve Status**: Shows if watering is active
- **Countdown Timer**: Time remaining in watering cycle
- **History Chart**: 24-hour moisture trend

### Controls
- **Manual Water**: Tap to water for the configured duration
- **Settings**: Adjust thresholds and watering time
- **Info**: View sensor status and last update time

### Understanding Readings
- **Green Zone** (60-100%): Soil is wet, no watering needed
- **Yellow Zone** (40-60%): Adequate moisture
- **Red Zone** (0-40%): Dry soil, watering recommended

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Agriflow System                         │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ESP32 Hardware          Web Server            Database  │
│  ┌──────────────────┐   ┌──────────────────┐ ┌────────┐ │
│  │ • Moisture Sensor│──→│ Node.js/Express  │→│PostgreSQL│
│  │ • Servo Motor    │   │ • REST API       │ │ • Store  │
│  │ • WiFi Module    │   │ • Static Files   │ │ readings │
│  │ • Config Portal  │←──│ • Rate Limiting  │ └────────┘ │
│  └──────────────────┘   └──────────────────┘            │
│         │                       ▲                         │
│         └───────── HTTPS ───────┘                        │
│                                                           │
│  ┌──────────────────────────────────────┐               │
│  │   Web Dashboard (HTML/CSS/JS)        │               │
│  │  • Real-time moisture display        │               │
│  │  • Watering controls                 │               │
│  │  • Settings configuration             │               │
│  │  • Mobile-responsive design           │               │
│  └──────────────────────────────────────┘               │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

## 🌐 Deployment

### Deploy on Render (Free)

1. **Create Render Account**: https://render.com
2. **Create PostgreSQL Database**: Add a free tier PostgreSQL instance
3. **Create Web Service**:
   - Connect your GitHub repo
   - Set environment variables (copy from `.env`)
   - Deploy automatically on push
4. **Update ESP32 Configuration**:
   - Set server IP to your Render app URL
   - Restart ESP32

### Deploy Locally (Docker)

```bash
docker-compose up
```

See `docker-compose.yml` for details (if available).

## 🔧 API Endpoints

### Health Check
```
GET /api/health
→ { status: "ok", db: "connected" }
```

### Get Recent Readings
```
GET /api/readings?limit=100
→ [{id, timestamp, moisture_percent, valve_open, ...}, ...]
```

### Send Sensor Data (from ESP32)
```
POST /api/readings
Body: { moisture_percent, valve_open, watering_minutes }
→ { success: true }
```

### Get Configuration
```
GET /api/config
→ { openThreshold: 40, wateringMinutes: 3 }
```

### Update Configuration
```
POST /api/config
Body: { openThreshold: 40, wateringMinutes: 3 }
→ { success: true }
```

## 📁 Project Structure

```
Agriflow_demo_myself/
├── README.md                          # This file
├── PRODUCT.md                         # Product specification
├── DESIGN.md                          # Design system & brand guidelines
├── server.js                          # Express.js server
├── package.json                       # Node.js dependencies
├── index.html                         # Dashboard UI
├── style.css                          # Dashboard styling
├── script.js                          # Dashboard functionality
├── Procfile                           # Render.com deployment config
├── render.yaml                        # Render.com service definition
└── moisture-sensor_code/              # ESP32 firmware
    └── ESP32_SmartSprinkler/
        ├── ESP32_SmartSprinkler.ino   # Main firmware
        ├── config_portal.h             # WiFi config
        └── libraries/
            └── ESP32Servo/             # Servo control library
```

## 🛠️ Development

### Running Locally

**Backend**:
```bash
npm install
npm run dev
```

**Database**:
```bash
# Create database
createdb agriflow

# The tables are auto-created on first connection
```

**Frontend**:
- Open `http://localhost:10000` in browser
- Changes to `index.html`, `style.css`, `script.js` reload automatically

### Editing Firmware

1. Install Arduino IDE: https://www.arduino.cc/en/software
2. Install ESP32 board in IDE
3. Edit `moisture-sensor_code/ESP32_SmartSprinkler/ESP32_SmartSprinkler.ino`
4. Connect ESP32 via USB
5. Click **Upload** or press `Ctrl+U`

## 🐛 Troubleshooting

### ESP32 Won't Connect to WiFi
- Check SSID and password in config portal
- Verify WiFi network is 2.4 GHz (not 5 GHz)
- Restart ESP32 and try config portal again

### Moisture Reading Always 0% or 100%
- Check sensor is properly connected to GPIO 34
- Verify `dryValue` and `wetValue` calibration
- Test sensor manually: place in dry soil, then water, check readings

### Dashboard Shows "Disconnected"
- Verify ESP32 and server are on same WiFi network
- Check server IP is correct in ESP32 config
- Look at server logs for errors: `npm run dev`

### Server Won't Start
- Verify Node.js is installed: `node --version`
- Install dependencies: `npm install`
- Check PostgreSQL is running (if local)
- Review `.env` file for DATABASE_URL

## 📖 How to Contribute

We welcome contributions! Here's how:

1. **Fork** this repository
2. **Create a branch**: `git checkout -b feature/your-feature`
3. **Make changes** and test thoroughly
4. **Commit**: `git commit -m "Add your feature"`
5. **Push**: `git push origin feature/your-feature`
6. **Open a Pull Request** with a clear description

### Areas We Need Help With
- 🎨 UI/UX improvements and accessibility
- 📱 Mobile responsiveness testing
- 📊 Additional sensor support (temperature, humidity)
- 🔒 Security hardening
- 📝 Documentation and translations
- 🐛 Bug fixes and optimizations

## 📜 License

This project is licensed under the **MIT License** - see the LICENSE file for details.

You are free to:
- ✅ Use for personal and commercial projects
- ✅ Modify and distribute
- ✅ Use privately or publicly

Just include the original license and copyright notice.

## 💬 Support & Community

- **Issues**: Report bugs or suggest features on GitHub Issues
- **Discussions**: Ask questions and share ideas
- **Documentation**: Check DESIGN.md and PRODUCT.md for more details

## 🙏 Acknowledgments

- ESP32 community for excellent microcontroller support
- PostgreSQL and Node.js ecosystems
- Open-source contributors who inspired this project

## 📞 Contact

- **Author**: Agriflow Team
- **GitHub**: [Your Repository URL]
- **Email**: [Your Email]
- **Website**: [Your Website]

---

**Made with 🌱 for gardeners, by gardeners.**

Start growing smarter today! 
