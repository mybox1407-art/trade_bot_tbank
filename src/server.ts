import { app } from './app';

const port = Number(process.env.PORT) || 3011;

app.listen(port, '0.0.0.0', () => {
  console.log(`Server started on port ${port}`);
});
