pub(crate) const S_BASE: u32 = 0xAC00;
pub(crate) const L_BASE: u32 = 0x1100;
pub(crate) const V_BASE: u32 = 0x1161;
pub(crate) const T_BASE: u32 = 0x11A7;
pub(crate) const L_COUNT: u32 = 19;
pub(crate) const V_COUNT: u32 = 21;
pub(crate) const T_COUNT: u32 = 28;
pub(crate) const N_COUNT: u32 = V_COUNT * T_COUNT;
pub(crate) const S_COUNT: u32 = L_COUNT * N_COUNT;

#[derive(Debug, Clone)]
pub(crate) enum HangulState {
    Empty,
    Choseong(u32),
    ChoseongJungseong(u32, u32),
    Complete(u32, u32, u32),
}

pub(crate) struct HangulComposer {
    pub(crate) state: HangulState,
    pub(crate) committed: String,
}

impl HangulComposer {
    pub(crate) fn new() -> Self {
        Self {
            state: HangulState::Empty,
            committed: String::new(),
        }
    }

    pub(crate) fn reset(&mut self) {
        self.state = HangulState::Empty;
        self.committed.clear();
    }

    pub(crate) fn compose_syllable(l: u32, v: u32, t: u32) -> char {
        debug_assert_eq!(T_BASE + 1, 0x11A8);
        if l >= L_COUNT || v >= V_COUNT || t >= T_COUNT {
            return '?';
        }

        let code = S_BASE + l * N_COUNT + v * T_COUNT + t;
        if code >= S_BASE + S_COUNT {
            return '?';
        }

        char::from_u32(code).unwrap_or('?')
    }

    pub(crate) fn commit_current(&mut self) {
        let ch = match self.state.clone() {
            HangulState::Empty => None,
            HangulState::Choseong(l) => char::from_u32(L_BASE + l),
            HangulState::ChoseongJungseong(l, v) => Some(Self::compose_syllable(l, v, 0)),
            HangulState::Complete(l, v, t) => Some(Self::compose_syllable(l, v, t)),
        };

        if let Some(ch) = ch {
            self.committed.push(ch);
        }
        self.state = HangulState::Empty;
    }

    pub(crate) fn preedit(&self) -> Option<char> {
        match self.state {
            HangulState::Empty => None,
            HangulState::Choseong(l) => char::from_u32(L_BASE + l),
            HangulState::ChoseongJungseong(l, v) => Some(Self::compose_syllable(l, v, 0)),
            HangulState::Complete(l, v, t) => Some(Self::compose_syllable(l, v, t)),
        }
    }

    pub(crate) fn feed_jamo(&mut self, jamo: Jamo) {
        match (self.state.clone(), jamo) {
            (HangulState::Empty, Jamo::Choseong(l)) => {
                self.state = HangulState::Choseong(l);
            }
            (HangulState::Empty, Jamo::Jungseong(v)) => {
                let ch = char::from_u32(V_BASE + v).unwrap_or('?');
                self.committed.push(ch);
                self.state = HangulState::Empty;
            }

            (HangulState::Choseong(l), Jamo::Choseong(l2)) => {
                let ch = char::from_u32(L_BASE + l).unwrap_or('?');
                self.committed.push(ch);
                self.state = HangulState::Choseong(l2);
            }
            (HangulState::Choseong(l), Jamo::Jungseong(v)) => {
                self.state = HangulState::ChoseongJungseong(l, v);
            }

            (HangulState::ChoseongJungseong(l, v), Jamo::Jungseong(v2)) => {
                if let Some(combined) = try_combine_vowel(v, v2) {
                    self.state = HangulState::ChoseongJungseong(l, combined);
                } else {
                    self.committed.push(Self::compose_syllable(l, v, 0));
                    self.state = HangulState::Empty;
                    self.feed_jamo(Jamo::Jungseong(v2));
                }
            }
            (HangulState::ChoseongJungseong(l, v), Jamo::Choseong(c)) => {
                if let Some(t) = choseong_to_jongseong(c) {
                    self.state = HangulState::Complete(l, v, t);
                } else {
                    self.committed.push(Self::compose_syllable(l, v, 0));
                    self.state = HangulState::Choseong(c);
                }
            }

            (HangulState::Complete(l, v, t), Jamo::Choseong(c)) => {
                if let Some(combined_t) = try_combine_jongseong(t, c) {
                    self.state = HangulState::Complete(l, v, combined_t);
                } else {
                    self.committed.push(Self::compose_syllable(l, v, t));
                    self.state = HangulState::Choseong(c);
                }
            }
            (HangulState::Complete(l, v, t), Jamo::Jungseong(v2)) => {
                if let Some((t_remain, new_l)) = split_composite_jongseong(t) {
                    self.committed.push(Self::compose_syllable(l, v, t_remain));
                    self.state = HangulState::ChoseongJungseong(new_l, v2);
                } else if let Some(new_l) = jongseong_to_choseong(t) {
                    self.committed.push(Self::compose_syllable(l, v, 0));
                    self.state = HangulState::ChoseongJungseong(new_l, v2);
                } else {
                    self.committed.push(Self::compose_syllable(l, v, t));
                    self.state = HangulState::Empty;
                    self.feed_jamo(Jamo::Jungseong(v2));
                }
            }
        }
    }

    pub(crate) fn backspace(&mut self) -> bool {
        match self.state.clone() {
            HangulState::Empty => false,
            HangulState::Choseong(_) => {
                self.state = HangulState::Empty;
                true
            }
            HangulState::ChoseongJungseong(l, v) => {
                if let Some((v_head, _)) = split_composite_vowel(v) {
                    self.state = HangulState::ChoseongJungseong(l, v_head);
                } else {
                    self.state = HangulState::Choseong(l);
                }
                true
            }
            HangulState::Complete(l, v, t) => {
                if let Some((t_head, _)) = split_composite_jongseong(t) {
                    self.state = HangulState::Complete(l, v, t_head);
                } else {
                    self.state = HangulState::ChoseongJungseong(l, v);
                }
                true
            }
        }
    }

    pub(crate) fn result(&self) -> String {
        let mut output = self.committed.clone();
        if let Some(preedit) = self.preedit() {
            output.push(preedit);
        }
        output
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Jamo {
    Choseong(u32),
    Jungseong(u32),
}

pub(crate) fn qwerty_to_jamo(ch: char) -> Option<Jamo> {
    match ch {
        'r' => Some(Jamo::Choseong(0)),
        'R' => Some(Jamo::Choseong(1)),
        's' => Some(Jamo::Choseong(2)),
        'e' => Some(Jamo::Choseong(3)),
        'E' => Some(Jamo::Choseong(4)),
        'f' => Some(Jamo::Choseong(5)),
        'a' => Some(Jamo::Choseong(6)),
        'q' => Some(Jamo::Choseong(7)),
        'Q' => Some(Jamo::Choseong(8)),
        't' => Some(Jamo::Choseong(9)),
        'T' => Some(Jamo::Choseong(10)),
        'd' => Some(Jamo::Choseong(11)),
        'w' => Some(Jamo::Choseong(12)),
        'W' => Some(Jamo::Choseong(13)),
        'c' => Some(Jamo::Choseong(14)),
        'z' => Some(Jamo::Choseong(15)),
        'x' => Some(Jamo::Choseong(16)),
        'v' => Some(Jamo::Choseong(17)),
        'g' => Some(Jamo::Choseong(18)),

        'k' => Some(Jamo::Jungseong(0)),
        'o' => Some(Jamo::Jungseong(1)),
        'i' => Some(Jamo::Jungseong(2)),
        'O' => Some(Jamo::Jungseong(3)),
        'j' => Some(Jamo::Jungseong(4)),
        'p' => Some(Jamo::Jungseong(5)),
        'u' => Some(Jamo::Jungseong(6)),
        'P' => Some(Jamo::Jungseong(7)),
        'h' => Some(Jamo::Jungseong(8)),
        'y' => Some(Jamo::Jungseong(12)),
        'n' => Some(Jamo::Jungseong(13)),
        'b' => Some(Jamo::Jungseong(17)),
        'm' => Some(Jamo::Jungseong(18)),
        'l' => Some(Jamo::Jungseong(20)),
        _ => None,
    }
}

pub(crate) fn choseong_to_jongseong(l: u32) -> Option<u32> {
    match l {
        0 => Some(1),
        2 => Some(4),
        3 => Some(7),
        5 => Some(8),
        6 => Some(16),
        7 => Some(17),
        9 => Some(19),
        10 => Some(20),
        11 => Some(21),
        12 => Some(22),
        14 => Some(23),
        15 => Some(24),
        16 => Some(25),
        17 => Some(26),
        18 => Some(27),
        _ => None,
    }
}

pub(crate) fn jongseong_to_choseong(t: u32) -> Option<u32> {
    match t {
        1 => Some(0),
        4 => Some(2),
        7 => Some(3),
        8 => Some(5),
        16 => Some(6),
        17 => Some(7),
        19 => Some(9),
        20 => Some(10),
        21 => Some(11),
        22 => Some(12),
        23 => Some(14),
        24 => Some(15),
        25 => Some(16),
        26 => Some(17),
        27 => Some(18),
        _ => None,
    }
}

pub(crate) fn try_combine_jongseong(t1: u32, l: u32) -> Option<u32> {
    match (t1, l) {
        (1, 9) => Some(3),
        (4, 12) => Some(5),
        (4, 18) => Some(6),
        (8, 0) => Some(9),
        (8, 6) => Some(10),
        (8, 7) => Some(11),
        (8, 9) => Some(12),
        (8, 16) => Some(13),
        (8, 17) => Some(14),
        (8, 18) => Some(15),
        (17, 9) => Some(18),
        _ => None,
    }
}

pub(crate) fn split_composite_jongseong(t: u32) -> Option<(u32, u32)> {
    match t {
        3 => Some((1, 9)),
        5 => Some((4, 12)),
        6 => Some((4, 18)),
        9 => Some((8, 0)),
        10 => Some((8, 6)),
        11 => Some((8, 7)),
        12 => Some((8, 9)),
        13 => Some((8, 16)),
        14 => Some((8, 17)),
        15 => Some((8, 18)),
        18 => Some((17, 9)),
        _ => None,
    }
}

pub(crate) fn try_combine_vowel(v1: u32, v2: u32) -> Option<u32> {
    match (v1, v2) {
        (8, 0) => Some(9),
        (8, 1) => Some(10),
        (8, 20) => Some(11),
        (13, 4) => Some(14),
        (13, 5) => Some(15),
        (13, 20) => Some(16),
        (18, 20) => Some(19),
        _ => None,
    }
}

pub(crate) fn split_composite_vowel(v: u32) -> Option<(u32, u32)> {
    match v {
        9 => Some((8, 0)),
        10 => Some((8, 1)),
        11 => Some((8, 20)),
        14 => Some((13, 4)),
        15 => Some((13, 5)),
        16 => Some((13, 20)),
        19 => Some((18, 20)),
        _ => None,
    }
}
