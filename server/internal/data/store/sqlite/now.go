package sqlite

import "time"

// nowUnix is a test seam for expiry checks (GetBan).
var nowUnix = func() int64 { return time.Now().Unix() }
