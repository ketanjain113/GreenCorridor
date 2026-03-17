# 🚦 Green Corridor  
### AI-Powered Emergency Vehicle Priority System

---

## 🧠 Overview

**Green Corridor** is a smart traffic management system that detects emergency vehicles in real-time and dynamically optimizes traffic signals to create a clear path.

The system uses **computer vision + predictive ETA logic** to reduce response time for ambulances, fire trucks, and police vehicles.

---

## 🚑 Problem Statement

Emergency vehicles often get stuck in traffic, leading to:

- Delayed medical response 🚨  
- Increased mortality risk  
- Inefficient urban traffic systems  

---

## 💡 Solution

Green Corridor solves this by:


Detect → Track → Predict → Act → Alert


- Detect emergency vehicles using AI  
- Track movement across frames  
- Predict arrival time (ETA)  
- Automatically simulate signal prioritization  
- Alert nearby vehicles to clear lane  

---

## ⚙️ Features

### 🔍 Emergency Vehicle Detection
- Uses YOLO-based model  
- Detects ambulance, fire truck, police vehicles  

### 🎯 Real-Time Tracking
- Tracks vehicles across frames  
- Maintains unique IDs  

### ⏱️ ETA Prediction (Core Feature)
- Calculates speed from motion  
- Predicts time to next intersection  

### 🚦 Smart Signal Control
- Automatically switches signal to GREEN  
- Based on ETA threshold  

### 🗺️ Live Map Visualization
- Displays vehicle movement  
- Shows route and intersections  

### ⚠️ Lane Clearance Alerts

Displays warning:

> ⚠ Emergency vehicle approaching — clear lane  

---

## 🏗️ System Architecture


Video Input / Camera Feed
↓
YOLO Detection Model
↓
Tracking Module
↓
Speed & ETA Calculation
↓
Decision Engine (Signal Logic)
↓
Backend (Node.js + WebSocket)
↓
Frontend (React Map UI)


---


---

## 🛠️ Tech Stack

### 🔹 Frontend
- React.js  
- Leaflet.js (Map Visualization)  
- Socket.io Client  

### 🔹 Backend
- Node.js (Express)  
- WebSocket (Socket.io)  

### 🔹 ML / AI
- YOLOv8 (Ultralytics)  
- OpenCV  
- Python  

---

## 🚀 How It Works

1. User uploads or streams traffic video  
2. System detects emergency vehicle  
3. Tracks movement across frames  
4. Calculates speed and ETA  
5. Signal logic activates (GREEN corridor)  
6. Alerts are displayed on UI  

---

## 📦 Installation

### 1️⃣ Clone Repository

```bash
git clone https://github.com/ketanjain113/GreenCorridor.git
cd GreenCorridor
```

### 2️⃣ Install Dependencies

Backend
```bash
cd backend
npm install
```

Frontend
```bash
cd frontend
npm install
```

ML (Python)
```bash
pip install ultralytics opencv-python numpy
```

###▶️ Running the Project

Start Backend
```bash
cd backend
npm start
```

Start Frontend
```bash
cd frontend
npm run dev
```

Run ML Detection
```bash
python detect.py
```

###📊 Demo Flow

1. Upload video
2. Emergency vehicle detected
3. ETA displayed
4. Signal turns GREEN
5. Alert appears

###🏆 Key Innovation

Predictive Traffic Control using ETA instead of reactive systems

Unlike traditional systems, Green Corridor:

Activates signals before arrival

Uses AI-based prediction

Works in real-time

###📈 Future Enhancements

Multi-vehicle priority system

Integration with real traffic cameras

IoT-based signal automation

GPS-based tracking

###👨‍💻 Contributors

[Ketan Jain]('github.com/ketanjain113)

[Kavish Jain]('github.com/kavish200)

[Sarthak Mahajan]('github.com/sarthakm811)

[Prayagi Sahajwani]('github.com/prayagi)
