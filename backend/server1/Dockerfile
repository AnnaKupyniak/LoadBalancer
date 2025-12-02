# 1. Базовий образ Node.js
FROM node:18

# 2. Робоча директорія всередині контейнера
WORKDIR /app

# 3. Копіюємо package.json та package-lock.json
COPY package*.json ./

# 4. Встановлюємо залежності
RUN npm install

COPY . .

# 6. Виставляємо порт, на якому буде працювати сервер
EXPOSE 8001

# 7. Команда запуску твого серверу
CMD ["node", "app.js"]
