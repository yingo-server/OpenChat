package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/yingo-server/OpenChat/server/internal/data/store"
)

// mediaStore implements store.MediaStore over media_media.
//
// Red line: Status!=1 media is unusable — that judgment is the CALLER's; the
// store just stores. RefCount deltas may be negative (message deleted).

type mediaStore struct{ db *sql.DB }

const insertMediaSQL = `INSERT INTO media_media
(media_id, uid, mtype, name, size, mime, width, height, duration_ms, status, sha256, created_at, ref_count, thumb_data, waveform)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

func (s *mediaStore) Insert(ctx context.Context, m *store.Media) error {
	if m == nil {
		return fmt.Errorf("sqlite: Insert: nil media")
	}
	rc := m.RefCount
	if _, err := s.db.ExecContext(ctx, insertMediaSQL,
		m.MediaID, m.UID, m.MType, m.Name, m.Size, m.Mime, m.Width, m.Height,
		m.DurationMS, m.Status, m.SHA256, m.CreatedAt, rc, m.ThumbData, m.Waveform); err != nil {
		if isDup(err) {
			return fmt.Errorf("sqlite: media %s exists: %w", m.MediaID, store.ErrDuplicate)
		}
		return fmt.Errorf("sqlite: insert media %s: %w", m.MediaID, err)
	}
	return nil
}

func (s *mediaStore) Get(ctx context.Context, mediaID string) (*store.Media, error) {
	var m store.Media
	err := s.db.QueryRowContext(ctx,
		`SELECT media_id, uid, mtype, name, size, mime, width, height, duration_ms, status, sha256, created_at, ref_count, thumb_data, waveform
FROM media_media WHERE media_id = ?`, mediaID).
		Scan(&m.MediaID, &m.UID, &m.MType, &m.Name, &m.Size, &m.Mime, &m.Width, &m.Height,
			&m.DurationMS, &m.Status, &m.SHA256, &m.CreatedAt, &m.RefCount, &m.ThumbData, &m.Waveform)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("sqlite: media %q: %w", mediaID, store.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: get media %q: %w", mediaID, err)
	}
	return &m, nil
}

func (s *mediaStore) UpdateStatus(ctx context.Context, mediaID string, status int) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE media_media SET status = ? WHERE media_id = ?`, status, mediaID)
	if err != nil {
		return fmt.Errorf("sqlite: update media status %q: %w", mediaID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("sqlite: media %q: %w", mediaID, store.ErrNotFound)
	}
	return nil
}

func (s *mediaStore) IncRefCount(ctx context.Context, mediaID string, delta int64) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE media_media SET ref_count = ref_count + ? WHERE media_id = ?`, delta, mediaID)
	if err != nil {
		return fmt.Errorf("sqlite: inc ref %q: %w", mediaID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("sqlite: media %q: %w", mediaID, store.ErrNotFound)
	}
	return nil
}

// AddRef is IncRefCount(+1) with existence asserted.
func (s *mediaStore) AddRef(ctx context.Context, mediaID string) error {
	return s.IncRefCount(ctx, mediaID, 1)
}
