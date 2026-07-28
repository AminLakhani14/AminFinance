import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from './store';

/** Typed `useDispatch` — knows about thunks and the RTK Query middleware. */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();

/** Typed `useSelector` — no need to annotate state in every call site. */
export const useAppSelector = useSelector.withTypes<RootState>();
