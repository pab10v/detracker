/**
 * DeTracker EKF (Extended Kalman Filter) 3D en WebAssembly
 * Modelo Matricial: [Intención, Velocidad, Volumen]
 */

class KalmanState {
  // Vector de estado (Intent, Velocity, Volume)
  x0: f64; x1: f64; x2: f64;
  
  // Matriz de Covarianza P (Diagonal principal para eficiencia O(1))
  p00: f64; p11: f64; p22: f64;

  // Media Gaussiana histórica
  mean0: f64; mean1: f64; mean2: f64;
  
  // Varianza histórica
  var0: f64; var1: f64; var2: f64;

  constructor() {
    this.x0 = 0.05; this.x1 = 0.05; this.x2 = 0.05;
    this.p00 = 1.0; this.p11 = 1.0; this.p22 = 1.0;
    
    this.mean0 = 0.1; this.mean1 = 0.1; this.mean2 = 0.1;
    this.var0 = 0.1; this.var1 = 0.1; this.var2 = 0.1;
  }
}

const states = new Map<i32, KalmanState>();

export function initTracker(domainId: i32): void {
  if (!states.has(domainId)) {
    states.set(domainId, new KalmanState());
  }
}

export function updateEKF(domainId: i32, z0: f64, z1: f64, z2: f64): f64 {
  if (!states.has(domainId)) {
    initTracker(domainId);
  }

  let state = states.get(domainId);

  // 1. PREDICCIÓN (Modelo Oculto de Markov - HMM)
  // Transition Matrix F: Intención hereda de Velocidad; Velocidad hereda de Volumen
  let pred_x0 = state.x0 * 0.9 + state.x1 * 0.1; 
  let pred_x1 = state.x1 * 0.8 + state.x2 * 0.2; 
  let pred_x2 = state.x2 * 0.9; 
  
  // Predicción P (Asumiendo ruido de proceso Q = 0.01)
  let p00 = state.p00 + 0.01;
  let p11 = state.p11 + 0.01;
  let p22 = state.p22 + 0.01;

  // 2. INNOVACIÓN (Residual Y = Z - H*X)
  let y0 = z0 - pred_x0;
  let y1 = z1 - pred_x1;
  let y2 = z2 - pred_x2;

  // 3. GANANCIA DE KALMAN (K = P / (P + R))
  // Asumiendo ruido de observación R = 0.1
  let k0 = p00 / (p00 + 0.1);
  let k1 = p11 / (p11 + 0.1);
  let k2 = p22 / (p22 + 0.1);

  // 4. ACTUALIZACIÓN DE ESTADO
  state.x0 = pred_x0 + k0 * y0;
  state.x1 = pred_x1 + k1 * y1;
  state.x2 = pred_x2 + k2 * y2;

  // Actualización de Covarianza P = (1 - K) * P
  state.p00 = (1.0 - k0) * p00;
  state.p11 = (1.0 - k1) * p11;
  state.p22 = (1.0 - k2) * p22;

  // 5. CÁLCULO DE ANOMALÍA (Distancia Multi-Dimensional)
  let std0 = Math.sqrt(state.var0); if (std0 < 0.001) std0 = 0.001;
  let std1 = Math.sqrt(state.var1); if (std1 < 0.001) std1 = 0.001;
  let std2 = Math.sqrt(state.var2); if (std2 < 0.001) std2 = 0.001;

  let zScore0 = Math.abs(state.x0 - state.mean0) / std0;
  let zScore1 = Math.abs(state.x1 - state.mean1) / std1;
  let zScore2 = Math.abs(state.x2 - state.mean2) / std2;

  // Obtenemos el vector de anomalía más severo de las 3 dimensiones
  let maxZScore = zScore0;
  if (zScore1 > maxZScore) maxZScore = zScore1;
  if (zScore2 > maxZScore) maxZScore = zScore2;

  // 6. APRENDIZAJE GAUSSIANO (Solo si es tráfico normal, <= 3 Sigmas)
  if (maxZScore <= 3.0) {
    state.mean0 = state.mean0 * 0.9 + state.x0 * 0.1;
    state.mean1 = state.mean1 * 0.9 + state.x1 * 0.1;
    state.mean2 = state.mean2 * 0.9 + state.x2 * 0.1;

    state.var0 = state.var0 * 0.9 + Math.abs(y0) * 0.1;
    state.var1 = state.var1 * 0.9 + Math.abs(y1) * 0.1;
    state.var2 = state.var2 * 0.9 + Math.abs(y2) * 0.1;
  }

  return maxZScore;
}

export function getStateX(domainId: i32): f64 {
  if (states.has(domainId)) return states.get(domainId).x0;
  return 0.0;
}
