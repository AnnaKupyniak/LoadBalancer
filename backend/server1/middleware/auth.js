const axios = require('axios');

const authMiddleware = async (req, res, next) => {
  try {
    console.log(`[${process.env.SERVER_ID}] Auth check for:`, req.url);
    
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log(`[${process.env.SERVER_ID}] No auth header`);
      return res.status(401).json({
        success: false,
        error: 'Будь ласка, увійдіть в систему'
      });
    }
    
    const token = authHeader.split(' ')[1];
    console.log(`[${process.env.SERVER_ID}] Token received (first 20 chars):`, token.substring(0, 20) + '...');
    
    // Верифікуємо токен через auth сервер
    try {
      const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:8000';
      console.log(`[${process.env.SERVER_ID}] Verifying token with: ${authUrl}`);
      
      const response = await axios.post(`${authUrl}/api/auth/verify`, {
        token
      }, { 
        timeout: 3000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`[${process.env.SERVER_ID}] Auth response:`, response.data.success);
      
      if (response.data.success) {
        req.userId = response.data.user.id;
        req.username = response.data.user.username;
        req.userEmail = response.data.user.email;
        next();
      } else {
        return res.status(401).json({
          success: false,
          error: 'Недійсний токен'
        });
      }
    } catch (verifyErr) {
      console.error(`[${process.env.SERVER_ID}] Auth verify error:`, verifyErr.message);
      console.error(`[${process.env.SERVER_ID}] Auth verify error details:`, verifyErr.response?.data);
      
      return res.status(401).json({
        success: false,
        error: 'Помилка верифікації токена',
        details: verifyErr.message
      });
    }
  } catch (error) {
    console.error(`[${process.env.SERVER_ID}] Auth middleware error:`, error.message);
    res.status(401).json({
      success: false,
      error: 'Помилка автентифікації'
    });
  }
};

module.exports = authMiddleware;