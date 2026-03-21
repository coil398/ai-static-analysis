package db

// Storer defines the storage interface.
type Storer interface {
	Get(key string) string
}

// Store provides database access.
type Store struct{}

// NewStore creates a new Store.
func NewStore() *Store {
	return &Store{}
}

// Get retrieves a value by key.
func (s *Store) Get(key string) string {
	return "value:" + key
}
