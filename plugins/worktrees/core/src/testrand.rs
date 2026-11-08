//! A seeded xorshift for property tests: deterministic, no dependency, so a failure reproduces.

#[derive(Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// 0..n
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        let i = usize::try_from(self.below(items.len() as u64)).unwrap_or(0);
        &items[i]
    }
    pub fn bool(&mut self) -> bool {
        self.next() & 1 == 1
    }
    /// up to `max` chars of mixed text: letters, digits, punctuation, spaces, a few non-ASCII
    pub fn text(&mut self, max: u64) -> String {
        const POOL: &[char] = &[
            'a', 'Z', 'q', '0', '9', ' ', '-', '_', '!', '/', '.', 'é', '✓', '\t', 'K',
        ];
        (0..self.below(max + 1)).map(|_| *self.pick(POOL)).collect()
    }
    /// 1..=max chars of [a-z0-9]
    pub fn ident(&mut self, max: u64) -> String {
        const POOL: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        (0..=self.below(max.max(1)))
            .map(|_| char::from(*self.pick(POOL)))
            .collect::<String>()
            .chars()
            .take(usize::try_from(max).unwrap_or(1))
            .collect()
    }
}
