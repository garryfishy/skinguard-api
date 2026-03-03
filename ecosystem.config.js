module.exports = {
  apps: [
    {
      name: 'skincare-api',
      script: './index.js',
      watch: false,
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
