package policy

import "encoding/json"

func unmarshal(body []byte, p *Policy) error { return json.Unmarshal(body, p) }
