pub fn health() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_is_ok() {
        assert!(health());
    }
}
