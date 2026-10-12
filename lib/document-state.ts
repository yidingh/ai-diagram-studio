export type Capture = { xml: string; capturedAt: string };
export type Candidate = {
  xml: string;
  requestId: string;
  nodeCount: number;
  edgeCount: number;
};
export type DocumentState = {
  current: Capture | null;
  previous: Capture | null;
  candidate: Candidate | null;
  applying: boolean;
};
export const initialDocumentState: DocumentState = {
  current: null, previous: null, candidate: null, applying: false,
};
type Action =
  | { type: 'capture'; capture: Capture }
  | { type: 'candidate'; candidate: Candidate }
  | { type: 'discard' | 'begin' | 'failed' }
  | { type: 'replaced'; outgoing: Capture; current: Capture; appliedCandidate: boolean };

/** Pure history transitions: returns new state, without changing XML or contacting the iframe.
 * current is the last accepted capture, not a live mirror of every manual edit. */
export function documentReducer(state: DocumentState, action: Action): DocumentState {
  switch (action.type) {
    case 'capture':
      return { ...state, current: action.capture };
    case 'candidate':
      return state.candidate || state.applying ? state : { ...state, candidate: action.candidate };
    case 'discard':
      return state.applying ? state : { ...state, candidate: null };
    case 'begin':
      return { ...state, applying: true };
    case 'failed':
      // Failure must not discard either recovery history or an unapplied candidate.
      return { ...state, applying: false };
    case 'replaced':
      // Commit both slots together only after verification. Restore also saves its outgoing version.
      return {
        ...state,
        applying: false,
        previous: action.outgoing,
        current: action.current,
        candidate: action.appliedCandidate ? null : state.candidate,
      };
  }
}
