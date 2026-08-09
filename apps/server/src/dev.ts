// 开发入口只负责明确运行模式，实际 HTTP 服务仍由 main.ts 统一启动。
process.env.NODE_ENV = 'development';
await import('./main.js');
