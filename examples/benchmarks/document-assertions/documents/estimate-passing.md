# Booking widget — estimate

## Assumptions

- The clinic's website accepts an embedded script.
- Email is sent through the clinic's existing SMTP account.

## Estimate

| Work item      | Hours | Notes                    |
| -------------- | ----: | ------------------------ |
| Backend API    |    24 | slots, bookings, email   |
| Widget         |    20 | embeddable script        |
| Admin page     |    12 | working hours            |
| QA             |  8–12 | manual and smoke tests   |
| Project management | 6 | weekly check-ins        |

## Risks

- The SMTP account may rate-limit confirmation emails.
