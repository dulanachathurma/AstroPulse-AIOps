# AstroPulse AIOps

AstroPulse AIOps is a comprehensive platform designed for intelligent IT operations. It seamlessly integrates a powerful AI analytics engine, a robust API gateway, and an intuitive dashboard to provide real-time insights and system monitoring.

## 🚀 Architecture

The project is structured into three main components:

- **AI Analytics Engine** (`ai-analytics-engine/`): A Python-based engine that processes data and provides intelligent AI-driven analytics.
- **Ballerina Gateway** (`ballerina-gateway/`): A high-performance API gateway built with Ballerina to handle routing, orchestration, and integrations.
- **Dashboard** (`dashboard/`): A modern, responsive web application built with Vite and Tailwind CSS for visualizing system metrics and AI insights.

## 📁 Project Structure

```text
AstroPulse-AIOps/
├── ai-analytics-engine/  # Python, AI/ML models, Analytics logic
├── ballerina-gateway/    # Ballerina API Gateway
└── dashboard/            # Frontend (Vite, Tailwind CSS)
```

## 🛠️ Tech Stack

- **Backend / Analytics:** Python
- **API Gateway:** Ballerina
- **Frontend:** Vite, Node.js, Tailwind CSS

## ⚙️ Getting Started

### 1. AI Analytics Engine
```bash
cd ai-analytics-engine
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

### 2. Ballerina Gateway
```bash
cd ballerina-gateway
bal run
```

### 3. Dashboard
```bash
cd dashboard
npm install
npm run dev
```

## 📄 License
This project is licensed under the MIT License.
