package pkg

import "example.com/testproject/internal/db"

// Service provides business logic.
type Service struct {
	store *db.Store
}

// NewService creates a new Service.
func NewService() *Service {
	return &Service{store: db.NewStore()}
}

// Hello returns a greeting.
func (s *Service) Hello() string {
	return "hello from service"
}
