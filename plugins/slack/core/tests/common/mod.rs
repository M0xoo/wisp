//! A small seeded generator for the property tests: the same seed, the same cases, no dependency.
#![allow(dead_code)]

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % (n.max(1) as u64)).unwrap_or(0)
    }
    /// A string of `len` characters picked from `alphabet`.
    pub fn string(&mut self, alphabet: &[&str], len: usize) -> String {
        (0..len).map(|_| alphabet[self.below(alphabet.len())]).collect()
    }
    pub fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| (self.next() & 0xff) as u8).collect()
    }
}
