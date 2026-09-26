/**
 * Stage colours. Left limbs teal, right limbs amber (calm, distinguishable for common colour
 * vision deficiencies by lightness as well as hue). Contact-state colours avoid both.
 */
export const PALETTE = {
  background: 0xeef1f4,
  backgroundDark: 0x161b22,
  floor: 0xe3e6ea,
  floorDark: 0x232a33,
  gridMajor: 0xb9c0c9,
  gridMinor: 0xd2d7dd,
  gridMajorDark: 0x3a4450,
  gridMinorDark: 0x2b333d,
  furniture: 0xb8a58c,
  furnitureEdge: 0x6f604c,
  step: 0xa9b4c2,
  stepEdge: 0x5d6978,

  body: 0x8792a2,
  head: 0x9aa4b2,
  face: 0x4a5463,
  left: 0x2a9d95,
  leftToe: 0x6cc7bf,
  right: 0xd9962b,
  rightToe: 0xf0c475,
  dimmed: 0xb5bcc6,

  contactActive: 0x2f6fde,
  contactEngaging: 0x8a5cd6,
  contactReleasing: 0xc2559a,
  contactFail: 0xd63a3a,
  site: 0x1d2733,
  residual: 0xd6336c,
  trajectory: 0x51617a,
  trajectoryComparison: 0xa0a9b8,
  stabilization: 0xe8590c,
  hostBone: 0x0b7285,
} as const;

export type ContactStateColor = 'active' | 'engaging' | 'releasing' | 'fail';

export const CONTACT_STATE_CSS: Record<ContactStateColor, string> = {
  active: '#2f6fde',
  engaging: '#8a5cd6',
  releasing: '#c2559a',
  fail: '#d63a3a',
};
