# 🎊 نظام نقطة — الدليل الكامل للتشغيل

## هيكل المشروع
```
noqta-system/
├── server/
│   ├── server.js        ← السيرفر الرئيسي (Node.js)
│   ├── package.json     ← المكتبات المطلوبة
│   └── noqta.db         ← قاعدة البيانات (تتكوّن تلقائياً)
├── admin/
│   └── index.html       ← لوحة تحكم الأدمن
└── app/
    └── index.html       ← تطبيق الموبايل (للعملاء)
```

---

## 🚀 خطوات التشغيل

### 1. تثبيت Node.js
اتأكد عندك Node.js v18+ من: https://nodejs.org

### 2. تثبيت المكتبات
```bash
cd noqta-system/server
npm install
```

### 3. تشغيل السيرفر
```bash
npm start
```
أو للتطوير:
```bash
npm run dev
```

### 4. فتح البرامج
- **لوحة الأدمن:** http://localhost:3000/admin
- **تطبيق العملاء:** http://localhost:3000

---

## 🔑 أول دخول للأدمن
```
يوزر: admin
باسورد: admin123
```
⚠️ **غيّر الباسورد فوراً من الإعدادات!**

---

## 👥 إضافة عميل جديد
1. ادخل على لوحة الأدمن
2. اضغط "عميل جديد"
3. حدد:
   - **اليوزر** — يستخدمه العميل للدخول
   - **الباسورد** — يستخدمه العميل للدخول
   - **اسم صاحب الكشف** — اسمه في التطبيق
   - **مدة الاشتراك** — بالأيام (30 = شهر، 365 = سنة)
4. العميل يفتح التطبيق ويدخل بيوزره وباسورده

---

## ☁️ رفع السيرفر على الإنترنت (اختياري)

### خيار 1 — Railway (مجاني)
1. اعمل حساب على https://railway.app
2. ارفع المجلد `server/` 
3. السيرفر هيشتغل تلقائياً
4. افتح ملف `app/index.html` وغيّر:
   ```js
   const SERVER_URL = 'https://noqta-xxxxx.railway.app';
   ```

### خيار 2 — VPS (DigitalOcean / Hostinger)
```bash
# على السيرفر:
git clone <repo>
cd noqta-system/server
npm install
npm install -g pm2
pm2 start server.js --name noqta
pm2 save
pm2 startup
```

### خيار 3 — Render.com (مجاني)
1. اعمل حساب على https://render.com
2. ارفع المشروع من GitHub
3. اختار "Web Service" وحدد مجلد `server/`
4. Start Command: `node server.js`

---

## 📱 تحويل التطبيق لـ APK (اختياري)

### باستخدام PWA Builder
1. ارفع `app/index.html` على أي هوستنج
2. افتح https://www.pwabuilder.com
3. حط الرابط واعمل APK مجاناً

### باستخدام Capacitor
```bash
npm install -g @capacitor/cli
npx cap init
npx cap add android
npx cap open android
```

---

## 🔧 متغيرات البيئة (.env)
```env
PORT=3000
JWT_SECRET=your_super_secret_here_change_this
DB_PATH=./noqta.db
```

---

## 📊 الـ API (للمطورين)

### تسجيل دخول العميل
```
POST /api/auth/login
{ "username": "xxx", "password": "xxx" }
```

### جلب البيانات
```
GET /api/data
Authorization: Bearer <token>
```

### مزامنة البيانات
```
POST /api/data/sync
Authorization: Bearer <token>
{ "lee": [...], "alaya": [...], "profile": {...} }
```

### تسجيل دخول الأدمن
```
POST /api/auth/admin-login
{ "username": "admin", "password": "xxx" }
```

### قائمة العملاء (أدمن)
```
GET /api/admin/clients
Authorization: Bearer <admin_token>
```

---

## 🛡️ الأمان
- كل عميل يشوف بياناته هو بس
- JWT tokens صالحة 30 يوم
- باسوردات مشفرة بـ bcrypt
- WebSocket مع تحقق من التوكن

---

## 🔄 Real-time Sync
- أي تغيير على أي جهاز يتعكس فوراً على كل الأجهزة
- الأدمن يقدر يفعّل / يوقف / يجدد اشتراك أي عميل
- العميل بيعرف فوراً لو اشتراكه اتجدد أو وُقف
