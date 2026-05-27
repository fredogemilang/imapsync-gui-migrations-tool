import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import handlebars from 'vite-plugin-handlebars';
import tailwindcss from '@tailwindcss/vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  plugins: [
    tailwindcss(),
    handlebars({
      partialDirectory: resolve(__dirname, 'partials'),
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        overview: resolve(__dirname, 'overview.html'),
        yourMigration: resolve(__dirname, 'your-migration.html'),
        migrations: resolve(__dirname, 'migrations.html'),
        migrationsStep2: resolve(__dirname, 'migrations-step2.html'),
        migrationsStep3: resolve(__dirname, 'migrations-step3.html'),
        bulkMigrations: resolve(__dirname, 'bulk-migrations.html'),
        bulkMigrationsStep2: resolve(__dirname, 'bulk-migrations-step2.html'),
        bulkMigrationsStep3: resolve(__dirname, 'bulk-migrations-step3.html'),
        settings: resolve(__dirname, 'settings.html'),
        changePassword: resolve(__dirname, 'change-password.html'),
      },
    },
  },
};
