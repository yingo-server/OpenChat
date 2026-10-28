package pipe

import "time"

var (
	nowSec   = func() int64 { return time.Now().Unix() }
	nowMilli = func() int64 { return time.Now().UnixMilli() }
)
