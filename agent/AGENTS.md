# Global agent instructions

## Go 1.26: `new(expr)`

Go 1.26 extends the built-in `new` so its operand may be an expression; it allocates storage initialized to that expression's value and returns a pointer.

```go
p := new(int64(300)) // *int64 pointing to 300
```
