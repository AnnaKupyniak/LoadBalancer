require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('./models/User');

const app = express();
app.use(express.json());
app.use(cors());

// Підключення до MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Auth MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'auth-server' });
});

// Реєстрація
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Валідація
    if (!username || !email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Будь ласка, заповніть всі поля' 
      });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        error: 'Пароль має бути не менше 6 символів' 
      });
    }
    
    // Перевірка наявності користувача
    const existingUser = await User.findOne({ 
      $or: [{ email: email.toLowerCase() }, { username }] 
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        error: 'Користувач з таким email або іменем вже існує' 
      });
    }
    
    // Створення користувача
    const user = new User({ 
      username, 
      email: email.toLowerCase(), 
      password 
    });
    
    await user.save();
    
    // Генерація токена
    const token = user.generateAuthToken();
    
    res.status(201).json({
      success: true,
      message: 'Реєстрація успішна!',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Помилка сервера при реєстрації' 
    });
  }
});

// Логін
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Будь ласка, введіть email та пароль' 
      });
    }
    
    // Знаходимо користувача
    const user = await User.findOne({ 
      email: email.toLowerCase() 
    });
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Невірний email або пароль' 
      });
    }
    
    // Перевіряємо пароль
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        error: 'Невірний email або пароль' 
      });
    }
    
    // Генерація токена
    const token = user.generateAuthToken();
    
    res.json({
      success: true,
      message: 'Вхід успішний!',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        tasksCompleted: user.tasksCompleted
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Помилка сервера при вході' 
    });
  }
});

// Верифікація токена (для server1/server2)
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Токен не надано' 
      });
    }
    
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Знаходимо користувача для підтвердження
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ 
        success: false, 
        error: 'Користувач не знайдений або деактивований' 
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });
    
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false, 
        error: 'Недійсний токен' 
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        error: 'Термін дії токену закінчився' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Помилка верифікації токена' 
    });
  }
});

// Профіль користувача
app.get('/api/auth/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: 'Токен не надано' 
      });
    }
    
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await User.findById(decoded.userId)
      .select('-password'); // Не повертаємо пароль
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'Користувач не знайдений' 
      });
    }
    
    res.json({
      success: true,
      user
    });
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Помилка при отриманні профілю' 
    });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🔐 Auth Server запущено на порту ${PORT}`);
  console.log(`🔑 JWT секрет: ${process.env.JWT_SECRET ? 'Налаштовано' : 'Не налаштовано!'}`);
});