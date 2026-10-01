/** Backend origin shared by HTTP requests and the live price stream. */
export const backendUrl = (
  import.meta.env.VITE_API_URL ?? 'https://aminfinance-backend.onrender.com'
).replace(/\/+$/, '');
