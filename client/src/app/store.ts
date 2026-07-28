import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { api } from '@/services/api';
import settingsReducer from '@/features/settings/settingsSlice';

export const store = configureStore({
  reducer: {
    settings: settingsReducer,
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(api.middleware),
  devTools: import.meta.env.DEV,
});

// Enables refetchOnFocus / refetchOnReconnect. Combined with the visibility
// check, this is what stops a backgrounded tab from burning API quota.
setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
