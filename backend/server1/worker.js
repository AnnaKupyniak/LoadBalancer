const { parentPort, workerData } = require('worker_threads');

const { taskId, start, end, initialValue } = workerData;
let current = BigInt(start);
const bigEnd = BigInt(end);
let accumulation = BigInt(initialValue || 1);

const totalSteps = Number(bigEnd - current + 1n);
let stepsDone = 0;
let isCancelled = false;

// Додаємо обробник повідомлень про скасування
if (parentPort) {
  parentPort.on('message', (message) => {
    if (message.type === 'cancel') {
      console.log(`[Worker ${taskId}] Отримано команду скасування, негайно завершую...`);
      isCancelled = true;
      
      // Відправляємо повідомлення про скасування
      if (parentPort && parentPort.postMessage) {
        parentPort.postMessage({
          type: 'cancelled',
          taskId,
          message: 'Задачу скасовано користувачем'
        });
        console.log(`[Worker ${taskId}] Повідомлення про скасування відправлено`);
      }
      
      // Виходимо негайно
      process.exit(0);
    }
  });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const FIXED_DURATION_SECONDS = 10;

async function calculate() {
    const startTime = Date.now();

    if (parentPort) {
        parentPort.postMessage({
            type: 'progress',
            taskId,
            currentValue: accumulation.toString(),
            progress: 0,
            stepInfo: `Початок обчислення ${start}-${end}`
        });
    }
    
    await sleep(1000);

    // Перевіряємо чи не скасовано перед продовженням
    if (isCancelled) {
        console.log(`[Worker ${taskId}] Обчислення скасовано на етапі ініціалізації`);
        return;
    }

    if (parentPort) {
        parentPort.postMessage({
            type: 'progress',
            taskId,
            currentValue: accumulation.toString(),
            progress: 10,
            stepInfo: `Ініціалізація завершена`
        });
    }
    
    let delayPerStep = 0;
    if (totalSteps > 0) {
        const computeTime = 2000;
        const delayTime = (FIXED_DURATION_SECONDS * 1000) - computeTime - 1000; 
        delayPerStep = Math.max(100, delayTime / totalSteps);
    }

    console.log(`[Worker ${taskId}] Затримка на крок: ${delayPerStep.toFixed(0)}мс, всього кроків: ${totalSteps}`);

    // Частіша перевірка на скасування
    while (current <= bigEnd) {
        // Часта перевірка на скасування
        if (isCancelled) {
            console.log(`[Worker ${taskId}] Обчислення перервано через скасування на кроці ${current}`);
            return;
        }
        
        accumulation *= current;
        stepsDone++;
        
        // Більш часте відправлення прогресу
        if (stepsDone === 1 || stepsDone % Math.max(1, Math.floor(totalSteps / 10)) === 0 || current === bigEnd) {
            const progress = Math.min(100, 10 + (stepsDone / totalSteps) * 85);
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            
            if (!isCancelled && parentPort) {
                parentPort.postMessage({
                    type: 'progress',
                    taskId,
                    currentValue: accumulation.toString(),
                    progress: progress,
                    stepInfo: `${current}! (${elapsedSeconds.toFixed(1)}с)`
                });
            }
        }
        
        // Менша затримка для швидшої реакції на скасування
        if (delayPerStep > 0 && !isCancelled) {
            // Розбиваємо затримку на частини для частішої перевірки
            const chunkSize = 50;
            for (let i = 0; i < delayPerStep; i += chunkSize) {
                if (isCancelled) break;
                await sleep(Math.min(chunkSize, delayPerStep - i));
            }
        }
        
        // Частіша перевірка event loop
        if (stepsDone % 10 === 0 && !isCancelled) {
            await new Promise(resolve => setImmediate(resolve));
        }
        
        current++;
    }

    // Перевіряємо ще раз перед фіналізацією
    if (isCancelled) {
        console.log(`[Worker ${taskId}] Задача скасована, не відправляю фінальний результат`);
        return;
    }

    const totalTime = (Date.now() - startTime) / 1000;

    if (parentPort) {
        parentPort.postMessage({
            type: 'progress',
            taskId,
            currentValue: accumulation.toString(),
            progress: 99,
            stepInfo: `Фіналізація... (${totalTime.toFixed(1)}с)`
        });
    }
    
    await sleep(500);
    
    if (parentPort && !isCancelled) {
        parentPort.postMessage({
            type: 'done',
            taskId,
            result: accumulation.toString(),
            totalTime: totalTime
        });
    }
}

// Обробка непередбачених помилок
process.on('uncaughtException', (error) => {
    console.error(`[Worker ${taskId}] Непередбачена помилка:`, error);
    if (parentPort) {
        parentPort.postMessage({
            type: 'error',
            taskId,
            error: error.message
        });
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[Worker ${taskId}] Необроблений rejection:`, reason);
    if (parentPort) {
        parentPort.postMessage({
            type: 'error',
            taskId,
            error: 'Unhandled rejection: ' + reason
        });
    }
});

// Запускаємо обчислення
calculate().catch(error => {
    console.error(`[Worker ${taskId}] ПОМИЛКА:`, error);
    
    if (parentPort) {
        parentPort.postMessage({
            type: 'error',
            taskId,
            error: error.message
        });
    }
});